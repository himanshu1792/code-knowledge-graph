"""LLM enrichment pass (optional, high-value) — Azure OpenAI.

Adds per-node one-line summaries and a feature/capability -> files map, using an
Azure OpenAI chat deployment. **Hard anti-hallucination constraint:** enrichment
may only reference node IDs / files that already exist in SQLite. Every write is
validated against the live graph and rejected otherwise — the model cannot invent
files or symbols.

The pass is entirely optional: if Azure OpenAI is not configured, callers fall
back to the deterministic feature map in ``spring.py``.

Configuration (env vars, or pass explicitly to ``enrich``):
  AZURE_OPENAI_API_KEY      — the Azure OpenAI key
  AZURE_OPENAI_ENDPOINT     — e.g. https://my-resource.openai.azure.com
  AZURE_OPENAI_DEPLOYMENT   — the chat model *deployment* name (used as `model`)
  AZURE_OPENAI_API_VERSION  — defaults to 2024-10-21
"""

from __future__ import annotations

import json
import os
from typing import Optional

DEFAULT_API_VERSION = "2024-10-21"
DEFAULT_DEPLOYMENT = "gpt-4o-mini"


class EnrichmentRejected(Exception):
    """Raised when an enrichment write references a non-existent node or file.

    This is the anti-hallucination gate: it fires *before* any data is written.
    """


# --- anti-hallucination gate (pure, independently testable) --------------------

def write_summary(conn, node_id: str, summary: str) -> None:
    """Set a node summary, but only if the node exists. Otherwise reject."""
    from . import db

    if node_id not in db.node_ids(conn):
        raise EnrichmentRejected(f"summary references unknown node id: {node_id!r}")
    conn.execute("UPDATE nodes SET summary = ? WHERE id = ?", (summary, node_id))


def write_feature(
    conn,
    feature_id: str,
    name: str,
    description: str,
    files: list[str],
    entry_nodes: Optional[dict[str, str]] = None,
) -> None:
    """Write a feature + its files, rejecting any unknown file or entry node.

    The whole feature is rejected (nothing written) if *any* referenced file is
    not present in the graph, or any entry node id does not exist.
    """
    from . import db

    known_files = db.files(conn)
    known_nodes = db.node_ids(conn)
    entry_nodes = entry_nodes or {}

    for f in files:
        if f not in known_files:
            raise EnrichmentRejected(f"feature {name!r} references unknown file: {f!r}")
    for f, nid in entry_nodes.items():
        if nid is not None and nid not in known_nodes:
            raise EnrichmentRejected(
                f"feature {name!r} references unknown entry node: {nid!r}"
            )

    conn.execute(
        "INSERT OR REPLACE INTO features (id, name, description) VALUES (?, ?, ?)",
        (feature_id, name, description),
    )
    for f in files:
        conn.execute(
            "INSERT OR IGNORE INTO feature_files (feature_id, file, entry_node_id) "
            "VALUES (?, ?, ?)",
            (feature_id, f, entry_nodes.get(f)),
        )


# --- LLM driver ----------------------------------------------------------------

def _context_payload(conn) -> dict:
    """Build a compact, ground-truth context for the model from the graph."""
    classes = conn.execute(
        "SELECT id, name, file, layer FROM nodes "
        "WHERE kind IN ('class','interface','enum') ORDER BY file"
    ).fetchall()
    endpoints = conn.execute(
        "SELECT http_method, path, id FROM nodes WHERE http_method IS NOT NULL ORDER BY path"
    ).fetchall()
    return {
        "classes": [
            {"id": r["id"], "name": r["name"], "file": r["file"], "layer": r["layer"]}
            for r in classes
        ],
        "endpoints": [
            {"method": r["http_method"], "path": r["path"], "node_id": r["id"]}
            for r in endpoints
        ],
    }


_SYSTEM = (
    "You enrich a code knowledge graph for a Java/Spring codebase. "
    "You are given the EXACT set of classes (with file paths and node ids) and HTTP "
    "endpoints already extracted deterministically from the code. "
    "You must ONLY reference files and node ids from that set — never invent names. "
    "Group the codebase into user-facing features/capabilities, and for each feature "
    "list the files that implement it (entry node id where applicable). "
    "Respond with a single JSON object of the form "
    '{"features": [{"name": str, "description": str, "files": [str], '
    '"entry_node_id": str (optional)}]}.'
)


def enrich(
    conn,
    deployment: Optional[str] = None,
    api_key: Optional[str] = None,
    endpoint: Optional[str] = None,
    api_version: Optional[str] = None,
) -> dict:
    """Run the Azure OpenAI enrichment pass. Returns a small report dict.

    Validates every write through the anti-hallucination gate. Writes that
    reference unknown nodes/files are skipped and counted in the report.
    """
    from openai import AzureOpenAI

    key = api_key or os.environ.get("AZURE_OPENAI_API_KEY")
    endpoint = endpoint or os.environ.get("AZURE_OPENAI_ENDPOINT")
    deployment = deployment or os.environ.get("AZURE_OPENAI_DEPLOYMENT") or DEFAULT_DEPLOYMENT
    api_version = api_version or os.environ.get("AZURE_OPENAI_API_VERSION") or DEFAULT_API_VERSION
    if not key or not endpoint:
        raise RuntimeError(
            "Azure OpenAI not configured; set AZURE_OPENAI_API_KEY and "
            "AZURE_OPENAI_ENDPOINT (and AZURE_OPENAI_DEPLOYMENT), or run without enrichment"
        )

    client = AzureOpenAI(api_key=key, azure_endpoint=endpoint, api_version=api_version)
    payload = _context_payload(conn)

    response = client.chat.completions.create(
        model=deployment,  # Azure: this is the *deployment* name
        response_format={"type": "json_object"},
        messages=[
            {"role": "system", "content": _SYSTEM},
            {
                "role": "user",
                "content": (
                    "Here is the ground-truth graph context (classes + endpoints) as JSON. "
                    "Produce the feature map JSON described in the system message.\n\n"
                    + json.dumps(payload, indent=2)
                ),
            },
        ],
    )
    text = response.choices[0].message.content or "{}"
    data = json.loads(text)

    written, rejected = 0, 0
    # clear any prior LLM features
    conn.execute("DELETE FROM features WHERE id LIKE 'llm:%'")
    conn.execute(
        "DELETE FROM feature_files WHERE feature_id IN "
        "(SELECT id FROM features WHERE id LIKE 'llm:%')"
    )
    for i, feat in enumerate(data.get("features", [])):
        fid = f"llm:{i}"
        entry = feat.get("entry_node_id")
        entry_nodes = {f: entry for f in feat.get("files", [])} if entry else None
        try:
            write_feature(
                conn,
                fid,
                feat.get("name", fid),
                feat.get("description", ""),
                feat.get("files", []),
                entry_nodes,
            )
            written += 1
        except EnrichmentRejected:
            rejected += 1

    conn.commit()
    return {"features_written": written, "features_rejected": rejected}
