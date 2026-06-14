"""MCP server exposing the knowledge graph to agents as ``kg_*`` tools.

Run via ``code-kg serve --repo <path>``. Backed by the read-only SQLite graph at
``.code-kg/graph.db``. Every tool answers from extracted facts — no guessing.
"""

from __future__ import annotations

import json
import os
import re
import sqlite3
from typing import Optional

from mcp.server.fastmcp import FastMCP

_DB_FILE: Optional[str] = None
mcp = FastMCP("code-kg")


# --- db access -----------------------------------------------------------------

def _conn() -> sqlite3.Connection:
    assert _DB_FILE, "server not initialized with a db path"
    conn = sqlite3.connect(f"file:{_DB_FILE}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def _owner_class(node_id: str) -> str:
    """Owning class id for a method/field node id (strip member suffix)."""
    return node_id.split("#", 1)[0]


def _resolve(conn: sqlite3.Connection, symbol: str) -> list[str]:
    """Resolve a user symbol to one or more node ids.

    Accepts: an exact node id, a class/interface simple name, a method name,
    or a file path (returns the classes in that file).
    """
    # exact node id
    row = conn.execute("SELECT id FROM nodes WHERE id = ?", (symbol,)).fetchone()
    if row:
        return [row["id"]]
    # file path (exact or basename)
    rows = conn.execute(
        "SELECT id FROM nodes WHERE (file = ? OR file LIKE ?) "
        "AND kind IN ('class','interface','enum')",
        (symbol, f"%/{os.path.basename(symbol)}" if "/" not in symbol else symbol),
    ).fetchall()
    if symbol.endswith(".java"):
        rows = conn.execute(
            "SELECT id FROM nodes WHERE (file = ? OR file LIKE ?) "
            "AND kind IN ('class','interface','enum')",
            (symbol, f"%{os.path.basename(symbol)}"),
        ).fetchall()
        if rows:
            return [r["id"] for r in rows]
    # class/interface by simple name
    rows = conn.execute(
        "SELECT id FROM nodes WHERE name = ? AND kind IN ('class','interface','enum')",
        (symbol,),
    ).fetchall()
    if rows:
        return [r["id"] for r in rows]
    # method by simple name
    rows = conn.execute(
        "SELECT id FROM nodes WHERE name = ? AND kind = 'method'", (symbol,)
    ).fetchall()
    return [r["id"] for r in rows]


def _expand_members(conn: sqlite3.Connection, ids: list[str]) -> set[str]:
    """For class ids, include their method/field node ids too."""
    out: set[str] = set(ids)
    for nid in ids:
        rows = conn.execute(
            "SELECT id FROM nodes WHERE id LIKE ? OR id LIKE ?",
            (f"{nid}#%", f"{nid}.%"),
        ).fetchall()
        out.update(r["id"] for r in rows)
    return out


def _node_brief(conn: sqlite3.Connection, node_id: str) -> dict:
    r = conn.execute(
        "SELECT id, kind, name, file, start_line, layer, http_method, path, summary "
        "FROM nodes WHERE id = ?", (node_id,)
    ).fetchone()
    if not r:
        return {"id": node_id}
    d = {"id": r["id"], "kind": r["kind"], "name": r["name"], "file": r["file"],
         "line": r["start_line"]}
    for k in ("layer", "http_method", "path", "summary"):
        if r[k]:
            d[k] = r[k]
    return d


# --- tools ---------------------------------------------------------------------

@mcp.tool()
def kg_architecture() -> dict:
    """Layered architecture overview: counts, layers, and endpoints.

    Call this FIRST on a new task to understand the codebase shape.
    """
    with _conn() as conn:
        counts = {
            "classes": conn.execute(
                "SELECT COUNT(*) FROM nodes WHERE kind IN ('class','interface','enum')"
            ).fetchone()[0],
            "endpoints": conn.execute(
                "SELECT COUNT(*) FROM nodes WHERE http_method IS NOT NULL"
            ).fetchone()[0],
            "injects": conn.execute(
                "SELECT COUNT(*) FROM edges WHERE kind = 'injects'"
            ).fetchone()[0],
        }
        layers: dict[str, list[str]] = {}
        for r in conn.execute(
            "SELECT layer, name FROM nodes WHERE layer IS NOT NULL "
            "AND kind IN ('class','interface','enum') ORDER BY layer, name"
        ):
            layers.setdefault(r["layer"], []).append(r["name"])
        endpoints = [
            {"method": r["http_method"], "path": r["path"], "handler": r["name"]}
            for r in conn.execute(
                "SELECT http_method, path, name FROM nodes "
                "WHERE http_method IS NOT NULL ORDER BY path"
            )
        ]
    return {"counts": counts, "layers": layers, "endpoints": endpoints}


@mcp.tool()
def kg_endpoints() -> list[dict]:
    """List all HTTP endpoints (method, path, handler) extracted from the code."""
    with _conn() as conn:
        return [
            {"method": r["http_method"], "path": r["path"],
             "handler": r["name"], "file": r["file"], "node_id": r["id"]}
            for r in conn.execute(
                "SELECT id, http_method, path, name, file FROM nodes "
                "WHERE http_method IS NOT NULL ORDER BY path"
            )
        ]


@mcp.tool()
def kg_endpoint(path: str) -> dict:
    """Describe one endpoint by path: its handler and the downstream call chain."""
    with _conn() as conn:
        r = conn.execute(
            "SELECT id, http_method, path, name, file FROM nodes "
            "WHERE http_method IS NOT NULL AND path = ?", (path,)
        ).fetchone()
        if not r:
            # tolerate trailing/leading slash differences
            r = conn.execute(
                "SELECT id, http_method, path, name, file FROM nodes "
                "WHERE http_method IS NOT NULL AND path LIKE ?",
                (f"%{path.strip('/')}%",)
            ).fetchone()
        if not r:
            return {"error": f"no endpoint matching {path!r}"}
        handler_id = r["id"]
        # downstream chain via calls (BFS)
        chain = _reachable(conn, {handler_id}, ("calls",), forward=True)
        chain.discard(handler_id)
        downstream = sorted({_owner_class(c) for c in chain})
        return {
            "method": r["http_method"], "path": r["path"], "handler": r["name"],
            "file": r["file"], "node_id": handler_id,
            "downstream_classes": [_node_brief(conn, c)["name"]
                                   for c in downstream
                                   if _node_brief(conn, c).get("name")],
        }


@mcp.tool()
def kg_find_files_for_feature(query: str) -> dict:
    """Find the files (and entry methods) that implement a feature/capability.

    This kills file-guessing: given a natural-language capability like
    "order sorting" or "user lookup", it returns the relevant source files
    plus likely entry methods, from the feature map and symbol names.
    """
    terms = _search_terms(query)
    with _conn() as conn:
        files: set[str] = set()
        entries: list[dict] = []
        feature_names: set[str] = set()

        # 1) features whose name/description matches
        for term in terms:
            for r in conn.execute(
                "SELECT id, name FROM features WHERE LOWER(name) LIKE ? "
                "OR LOWER(description) LIKE ?", (term, term)
            ):
                feature_names.add(r["name"])
                for ff in conn.execute(
                    "SELECT file FROM feature_files WHERE feature_id = ?", (r["id"],)
                ):
                    files.add(ff["file"])

        # 2) nodes (classes/methods/endpoints) whose name/path/summary matches
        seen_entry: set[str] = set()
        for term in terms:
            for r in conn.execute(
                "SELECT id, kind, name, file, http_method, path FROM nodes "
                "WHERE LOWER(name) LIKE ? OR LOWER(path) LIKE ? OR LOWER(summary) LIKE ?",
                (term, term, term)
            ):
                files.add(r["file"])
                if r["kind"] == "method" and r["id"] not in seen_entry:
                    seen_entry.add(r["id"])
                    entries.append({
                        "method": r["name"], "file": r["file"],
                        "endpoint": r["path"] if r["http_method"] else None,
                        "node_id": r["id"],
                    })

        return {
            "query": query,
            "features": sorted(feature_names),
            "files": sorted(files),
            "entry_methods": entries,
        }


@mcp.tool()
def kg_callers(symbol: str) -> list[dict]:
    """Who calls this class/method? (reverse `calls` edges)."""
    with _conn() as conn:
        ids = _expand_members(conn, _resolve(conn, symbol))
        if not ids:
            return []
        placeholders = ",".join("?" * len(ids))
        rows = conn.execute(
            f"SELECT DISTINCT src FROM edges WHERE kind='calls' AND dst IN ({placeholders})",
            tuple(ids),
        ).fetchall()
        return [_node_brief(conn, r["src"]) for r in rows]


@mcp.tool()
def kg_callees(symbol: str) -> list[dict]:
    """What does this class/method call? (forward `calls` edges)."""
    with _conn() as conn:
        ids = _expand_members(conn, _resolve(conn, symbol))
        if not ids:
            return []
        placeholders = ",".join("?" * len(ids))
        rows = conn.execute(
            f"SELECT DISTINCT dst FROM edges WHERE kind='calls' AND src IN ({placeholders})",
            tuple(ids),
        ).fetchall()
        return [_node_brief(conn, r["dst"]) for r in rows]


@mcp.tool()
def kg_impact_of(symbol: str) -> dict:
    """What is affected if this symbol/file changes? (reverse reachability).

    Walks `calls`, `injects`, and `routes_to` edges backward to find every
    class that (transitively) depends on the target.
    """
    with _conn() as conn:
        base = _resolve(conn, symbol)
        if not base:
            return {"symbol": symbol, "error": "symbol not found", "impacted": []}
        start = _expand_members(conn, base)
        reached = _reachable(
            conn, start,
            ("calls", "injects", "routes_to", "persists",
             "one_to_many", "many_to_one", "one_to_one", "many_to_many"),
            forward=False,
        )
        reached -= start
        self_classes = {_owner_class(s) for s in start}
        impacted = sorted({_owner_class(r) for r in reached} - self_classes)
        names = []
        for c in impacted:
            b = _node_brief(conn, c)
            if b.get("name"):
                names.append(b["name"])
        return {"symbol": symbol, "impacted": sorted(names)}


@mcp.tool()
def kg_neighbors(node: str) -> dict:
    """All direct neighbors of a node (incoming + outgoing edges, every kind)."""
    with _conn() as conn:
        ids = _resolve(conn, node)
        if not ids:
            return {"node": node, "error": "not found"}
        nid = ids[0]
        out = [
            {"kind": r["kind"], "to": _node_brief(conn, r["dst"])}
            for r in conn.execute("SELECT dst, kind FROM edges WHERE src = ?", (nid,))
        ]
        inc = [
            {"kind": r["kind"], "from": _node_brief(conn, r["src"])}
            for r in conn.execute("SELECT src, kind FROM edges WHERE dst = ?", (nid,))
        ]
        return {"node": _node_brief(conn, nid), "outgoing": out, "incoming": inc}


@mcp.tool()
def kg_describe(node: str) -> dict:
    """Full description of a node: signature, layer, annotations, summary, members."""
    with _conn() as conn:
        ids = _resolve(conn, node)
        if not ids:
            return {"node": node, "error": "not found"}
        nid = ids[0]
        r = conn.execute("SELECT * FROM nodes WHERE id = ?", (nid,)).fetchone()
        d = dict(r)
        if r["kind"] in ("class", "interface", "enum"):
            methods = conn.execute(
                "SELECT name, signature, http_method, path FROM nodes "
                "WHERE id LIKE ? AND kind='method' ORDER BY start_line", (f"{nid}#%",)
            ).fetchall()
            d["methods"] = [
                {"name": m["name"], "signature": m["signature"],
                 "endpoint": (f"{m['http_method']} {m['path']}" if m["http_method"] else None)}
                for m in methods
            ]
        return d


_REL_KINDS = ("one_to_many", "many_to_one", "one_to_one", "many_to_many")


def _loads(s) -> dict:
    try:
        return json.loads(s) if s else {}
    except (ValueError, TypeError):
        return {}


@mcp.tool()
def kg_data_model() -> dict:
    """The JPA/Hibernate persistence model: entities (+ table), relationships
    (with cascade / fetch / mappedBy / owning side / join columns), and which
    Spring Data repository manages each entity.

    Use this for tasks involving the database layer, schema, mapping, or queries.
    """
    with _conn() as conn:
        entities = []
        for r in conn.execute(
            "SELECT id, name, file, signature, attrs FROM nodes WHERE layer = 'entity' "
            "AND kind IN ('class','interface','enum') ORDER BY name"
        ):
            a = _loads(r["attrs"])
            entities.append({
                "entity": r["name"], "table": a.get("table"), "file": r["file"],
                "primary_key": [c["column"] for c in a.get("columns", []) if c.get("primary_key")],
                "column_count": len(a.get("columns", [])),
            })

        placeholders = ",".join("?" * len(_REL_KINDS))
        relationships = []
        for r in conn.execute(
            f"SELECT src, dst, kind, attrs FROM edges WHERE kind IN ({placeholders})",
            _REL_KINDS,
        ):
            a = _loads(r["attrs"])
            rel = {"from": _node_brief(conn, r["src"])["name"],
                   "kind": r["kind"],
                   "to": _node_brief(conn, r["dst"]).get("name"),
                   "owning": a.get("owning"),
                   "fetch": a.get("fetch")}
            for k in ("mapped_by", "cascade", "orphan_removal", "join_column",
                      "join_table", "referenced_column"):
                if k in a:
                    rel[k] = a[k]
            relationships.append(rel)

        repositories = [
            {"repository": _node_brief(conn, r["src"])["name"],
             "manages_entity": _node_brief(conn, r["dst"]).get("name")}
            for r in conn.execute("SELECT src, dst FROM edges WHERE kind = 'persists'")
        ]
    return {"entities": entities, "relationships": relationships,
            "repositories": repositories}


@mcp.tool()
def kg_entity(name: str) -> dict:
    """Full mapping of one JPA entity: table, every column (PK, generation,
    nullable/unique/length, lob/enum/version flags), its relationships with
    cascade/fetch/mappedBy/join details, and the repositories that manage it.
    """
    with _conn() as conn:
        ids = _resolve(conn, name)
        ids = [i for i in ids if _node_brief(conn, i).get("kind") in
               ("class", "interface", "enum")]
        if not ids:
            return {"entity": name, "error": "not found"}
        nid = ids[0]
        r = conn.execute("SELECT name, file, attrs FROM nodes WHERE id = ?", (nid,)).fetchone()
        a = _loads(r["attrs"])
        rels = []
        placeholders = ",".join("?" * len(_REL_KINDS))
        for e in conn.execute(
            f"SELECT dst, kind, attrs FROM edges WHERE src = ? AND kind IN ({placeholders})",
            (nid, *_REL_KINDS),
        ):
            d = _loads(e["attrs"])
            d.update({"kind": e["kind"], "to": _node_brief(conn, e["dst"]).get("name")})
            rels.append(d)
        # inbound relationships (other entities pointing here)
        inbound = [
            {"kind": e["kind"], "from": _node_brief(conn, e["src"]).get("name"),
             **_loads(e["attrs"])}
            for e in conn.execute(
                f"SELECT src, kind, attrs FROM edges WHERE dst = ? AND kind IN ({placeholders})",
                (nid, *_REL_KINDS),
            )
        ]
        managed_by = [
            _node_brief(conn, e["src"]).get("name")
            for e in conn.execute("SELECT src FROM edges WHERE dst = ? AND kind='persists'", (nid,))
        ]
        return {
            "entity": r["name"], "file": r["file"], "table": a.get("table"),
            "columns": a.get("columns", []),
            "relationships": rels,
            "referenced_by": inbound,
            "repositories": managed_by,
        }


# --- graph traversal -----------------------------------------------------------

def _reachable(conn, start: set[str], kinds: tuple[str, ...], forward: bool) -> set[str]:
    col_from, col_to = ("src", "dst") if forward else ("dst", "src")
    placeholders = ",".join("?" * len(kinds))
    seen = set(start)
    stack = list(start)
    while stack:
        cur = stack.pop()
        rows = conn.execute(
            f"SELECT {col_to} AS nxt FROM edges "
            f"WHERE {col_from} = ? AND kind IN ({placeholders})",
            (cur, *kinds),
        ).fetchall()
        for r in rows:
            nxt = r["nxt"]
            if nxt not in seen:
                seen.add(nxt)
                stack.append(nxt)
            # bridge method nodes to their owning class so impact spans classes
            owner = _owner_class(nxt)
            if owner != nxt and owner not in seen:
                seen.add(owner)
                stack.append(owner)
    return seen


def _search_terms(query: str) -> list[str]:
    """Tokenize a query into LIKE patterns, adding short stems (sorting→sort)."""
    tokens = [t for t in re.split(r"[^a-zA-Z0-9]+", query.lower()) if len(t) >= 2]
    terms: set[str] = set()
    for t in tokens:
        terms.add(f"%{t}%")
        if len(t) > 4:
            terms.add(f"%{t[:4]}%")  # crude stem to bridge sorting↔sorted
    return sorted(terms)


# --- entrypoint ----------------------------------------------------------------

def serve(db_file: str) -> None:
    global _DB_FILE
    _DB_FILE = os.path.abspath(db_file)
    mcp.run()
