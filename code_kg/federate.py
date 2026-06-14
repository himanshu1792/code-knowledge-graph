"""Federation: merge several per-service graphs into one and link them.

Each service is indexed independently (order-independent). ``federate`` copies
every service's nodes/edges into one merged graph — namespacing node ids with
``<service>::`` so they never collide — and then resolves outbound calls:
each ``calls_service`` edge (recorded by ``remote.py``) is matched to the called
service's real endpoint handler and linked with a ``calls_remote`` edge.

The match contract: a Feign ``name`` / RestTemplate host must equal the called
service's indexed ``--service`` name. Unmatched outbound calls stay as
``calls_service`` edges (visible as unresolved in ``kg_service_map``).
"""

from __future__ import annotations

import json
import sqlite3
from typing import Optional

from . import db

_NODE_COLS = (
    "id", "kind", "name", "file", "package", "signature", "start_line", "end_line",
    "annotations", "layer", "http_method", "path", "summary", "attrs", "service",
)


def _prefix(service: str, node_id: str) -> str:
    return f"{service}::{node_id}"


def _path_match(consumed: str, endpoint: str) -> bool:
    a = consumed.strip("/").split("/")
    b = endpoint.strip("/").split("/")
    if len(a) != len(b):
        return False
    for x, y in zip(a, b):
        if x == y:
            continue
        if x.startswith("{") or y.startswith("{"):  # path variable wildcard
            continue
        return False
    return True


def federate(output_db: str, services: list[tuple[str, str]]) -> dict:
    """Merge ``services`` (list of ``(service_name, source_db_path)``) into
    ``output_db`` and resolve cross-service calls. Returns a report dict.
    """
    out = db.connect(output_db)
    db.init_schema(out)
    db.reset(out)

    for name, src_path in services:
        src = sqlite3.connect(src_path)
        src.row_factory = sqlite3.Row
        try:
            _copy_service(out, src, name)
        finally:
            src.close()

    resolved, unresolved = _resolve_cross_calls(out)
    db.set_meta(out, "federated", "1")
    db.set_meta(out, "services", json.dumps([n for n, _ in services]))
    out.commit()
    out.close()
    return {"services": [n for n, _ in services],
            "links_resolved": resolved, "links_unresolved": unresolved}


def _copy_service(out, src, name: str) -> None:
    for row in src.execute(f"SELECT {', '.join(_NODE_COLS)} FROM nodes"):
        node = {c: row[c] for c in _NODE_COLS}
        node["id"] = _prefix(name, node["id"])
        node["service"] = node["service"] or name
        db.upsert_node(out, node)

    for row in src.execute("SELECT src, dst, kind, attrs FROM edges"):
        db.add_edge(out, _prefix(name, row["src"]), _prefix(name, row["dst"]),
                    row["kind"], row["attrs"])

    for row in src.execute("SELECT id, name, description FROM features"):
        out.execute("INSERT OR REPLACE INTO features (id, name, description) VALUES (?,?,?)",
                    (_prefix(name, row["id"]), row["name"], row["description"]))
    for row in src.execute("SELECT feature_id, file, entry_node_id FROM feature_files"):
        entry = _prefix(name, row["entry_node_id"]) if row["entry_node_id"] else None
        out.execute(
            "INSERT OR IGNORE INTO feature_files (feature_id, file, entry_node_id) "
            "VALUES (?,?,?)", (_prefix(name, row["feature_id"]), row["file"], entry))


def _resolve_cross_calls(out) -> tuple[int, int]:
    # real (non-external) endpoints, keyed for matching
    endpoints = [
        (r["service"], r["http_method"], r["path"], r["id"])
        for r in out.execute(
            "SELECT service, http_method, path, id FROM nodes "
            "WHERE http_method IS NOT NULL AND kind != 'external_endpoint'"
        )
    ]

    resolved = unresolved = 0
    cs_edges = out.execute(
        "SELECT src, dst, attrs FROM edges WHERE kind = 'calls_service'"
    ).fetchall()
    for e in cs_edges:
        a = json.loads(e["attrs"]) if e["attrs"] else {}
        target, method, path = a.get("target_service"), a.get("http_method"), a.get("path", "")
        handler = None
        for (svc, m, p, nid) in endpoints:
            if svc == target and m == method and _path_match(path, p or ""):
                handler = nid
                break
        if handler:
            db.add_edge(out, e["src"], handler, "calls_remote",
                        json.dumps({**a, "resolved": True}))
            # mark the external_endpoint node resolved + pointing at the real handler
            ext = json.loads(out.execute(
                "SELECT attrs FROM nodes WHERE id = ?", (e["dst"],)
            ).fetchone()["attrs"] or "{}")
            ext.update({"resolved": True, "resolved_to": handler})
            db.set_node_attrs(out, e["dst"], json.dumps(ext))
            resolved += 1
        else:
            unresolved += 1
    out.commit()
    return resolved, unresolved
