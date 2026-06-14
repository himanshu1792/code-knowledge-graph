"""LLM enrichment pass (optional, high-value).

Adds per-node one-line summaries and a feature/capability -> files map, using the
Claude API. **Hard anti-hallucination constraint:** enrichment may only reference
node IDs / files that already exist in SQLite. Every write is validated against the
live graph and rejected otherwise — the LLM cannot invent files or symbols.

The pass is entirely optional: if no API key is configured (or ``--no-llm`` is
used), callers fall back to the deterministic feature map in ``spring.py``.
"""

from __future__ import annotations

import json
import os
from typing import Optional

DEFAULT_MODEL = "claude-haiku-4-5"


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
    "list the files that implement it (entry node id where applicable)."
)


def enrich(conn, model: str = DEFAULT_MODEL, api_key: Optional[str] = None) -> dict:
    """Run the LLM enrichment pass. Returns a small report dict.

    Validates every write through the anti-hallucination gate. Writes that
    reference unknown nodes/files are skipped and counted in the report.
    """
    import anthropic

    key = api_key or os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        raise RuntimeError(
            "no ANTHROPIC_API_KEY set; run without enrichment or provide a key"
        )

    client = anthropic.Anthropic(api_key=key)
    payload = _context_payload(conn)

    schema = {
        "type": "object",
        "properties": {
            "features": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "name": {"type": "string"},
                        "description": {"type": "string"},
                        "files": {"type": "array", "items": {"type": "string"}},
                        "entry_node_id": {"type": "string"},
                    },
                    "required": ["name", "description", "files"],
                    "additionalProperties": False,
                },
            },
        },
        "required": ["features"],
        "additionalProperties": False,
    }

    response = client.messages.create(
        model=model,
        max_tokens=4096,
        system=_SYSTEM,
        output_config={"format": {"type": "json_schema", "schema": schema}},
        messages=[
            {
                "role": "user",
                "content": (
                    "Here is the ground-truth graph context (classes + endpoints). "
                    "Produce the feature map.\n\n"
                    + json.dumps(payload, indent=2)
                ),
            }
        ],
    )
    text = next((b.text for b in response.content if b.type == "text"), "{}")
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
                feat["name"],
                feat.get("description", ""),
                feat.get("files", []),
                entry_nodes,
            )
            written += 1
        except EnrichmentRejected:
            rejected += 1

    conn.commit()
    return {"features_written": written, "features_rejected": rejected}
