"""SQLite schema + helpers for the code knowledge graph.

The graph lives in a single file (default ``.code-kg/graph.db`` inside the target
repo). It is intentionally schema-light: ``nodes`` and ``edges`` form the generic
spine, and ``features`` / ``feature_files`` carry the (optional, enriched)
capability map.
"""

from __future__ import annotations

import os
import sqlite3
from contextlib import contextmanager
from typing import Iterable, Iterator, Optional

DEFAULT_DB_RELPATH = os.path.join(".code-kg", "graph.db")

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT
);

CREATE TABLE IF NOT EXISTS nodes (
    id          TEXT PRIMARY KEY,   -- stable fqn-style id, e.g. com.x.Foo or com.x.Foo#bar(int)
    kind        TEXT NOT NULL,      -- class|interface|enum|method|field
    name        TEXT NOT NULL,      -- simple name
    file        TEXT,               -- path relative to indexed root
    package     TEXT,
    signature   TEXT,
    start_line  INTEGER,
    end_line    INTEGER,
    annotations TEXT,               -- comma-separated annotation names (no @)
    layer       TEXT,               -- controller|service|repository|dao|config|model|util|app|component|null
    http_method TEXT,               -- GET|POST|... for endpoint handler methods
    path        TEXT,               -- resolved http path for endpoint handler methods
    summary     TEXT                -- one-line summary (enrichment)
);

CREATE TABLE IF NOT EXISTS edges (
    src  TEXT NOT NULL,
    dst  TEXT NOT NULL,
    kind TEXT NOT NULL,             -- calls|imports|extends|implements|injects|routes_to
    PRIMARY KEY (src, dst, kind)
);

CREATE TABLE IF NOT EXISTS features (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    description TEXT
);

CREATE TABLE IF NOT EXISTS feature_files (
    feature_id   TEXT NOT NULL,
    file         TEXT NOT NULL,
    entry_node_id TEXT,
    PRIMARY KEY (feature_id, file, entry_node_id)
);

CREATE INDEX IF NOT EXISTS idx_nodes_kind   ON nodes(kind);
CREATE INDEX IF NOT EXISTS idx_nodes_name   ON nodes(name);
CREATE INDEX IF NOT EXISTS idx_nodes_file   ON nodes(file);
CREATE INDEX IF NOT EXISTS idx_nodes_layer  ON nodes(layer);
CREATE INDEX IF NOT EXISTS idx_edges_src    ON edges(src);
CREATE INDEX IF NOT EXISTS idx_edges_dst    ON edges(dst);
CREATE INDEX IF NOT EXISTS idx_edges_kind   ON edges(kind);
"""


def resolve_db_path(repo: str, db_path: Optional[str] = None) -> str:
    """Resolve the on-disk location of the graph db for a given repo."""
    if db_path:
        return os.path.abspath(db_path)
    return os.path.abspath(os.path.join(repo, DEFAULT_DB_RELPATH))


def connect(db_file: str) -> sqlite3.Connection:
    os.makedirs(os.path.dirname(os.path.abspath(db_file)), exist_ok=True)
    conn = sqlite3.connect(db_file)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(SCHEMA)
    conn.commit()


def reset(conn: sqlite3.Connection) -> None:
    """Drop all graph content (used by a full re-index)."""
    for table in ("edges", "nodes", "feature_files", "features", "meta"):
        conn.execute(f"DELETE FROM {table}")
    conn.commit()


@contextmanager
def open_db(repo: str, db_path: Optional[str] = None) -> Iterator[sqlite3.Connection]:
    conn = connect(resolve_db_path(repo, db_path))
    init_schema(conn)
    try:
        yield conn
    finally:
        conn.close()


# --- write helpers -------------------------------------------------------------

def upsert_node(conn: sqlite3.Connection, node: dict) -> None:
    cols = (
        "id", "kind", "name", "file", "package", "signature",
        "start_line", "end_line", "annotations", "layer",
        "http_method", "path", "summary",
    )
    values = [node.get(c) for c in cols]
    placeholders = ", ".join(["?"] * len(cols))
    updates = ", ".join(f"{c}=excluded.{c}" for c in cols if c != "id")
    conn.execute(
        f"INSERT INTO nodes ({', '.join(cols)}) VALUES ({placeholders}) "
        f"ON CONFLICT(id) DO UPDATE SET {updates}",
        values,
    )


def add_edge(conn: sqlite3.Connection, src: str, dst: str, kind: str) -> None:
    conn.execute(
        "INSERT OR IGNORE INTO edges (src, dst, kind) VALUES (?, ?, ?)",
        (src, dst, kind),
    )


def set_meta(conn: sqlite3.Connection, key: str, value: str) -> None:
    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (key, value),
    )


def get_meta(conn: sqlite3.Connection, key: str) -> Optional[str]:
    row = conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else None


def delete_file_nodes(conn: sqlite3.Connection, file: str) -> None:
    """Remove all nodes (and their edges) belonging to a file. Used on reindex."""
    rows = conn.execute("SELECT id FROM nodes WHERE file = ?", (file,)).fetchall()
    ids = [r["id"] for r in rows]
    for nid in ids:
        conn.execute("DELETE FROM edges WHERE src = ? OR dst = ?", (nid, nid))
    conn.execute("DELETE FROM nodes WHERE file = ?", (file,))
    conn.execute("DELETE FROM feature_files WHERE file = ?", (file,))


# --- read helpers --------------------------------------------------------------

def node_ids(conn: sqlite3.Connection) -> set[str]:
    return {r["id"] for r in conn.execute("SELECT id FROM nodes")}


def files(conn: sqlite3.Connection) -> set[str]:
    return {r["file"] for r in conn.execute("SELECT DISTINCT file FROM nodes WHERE file IS NOT NULL")}


def counts(conn: sqlite3.Connection) -> dict:
    def one(sql: str, args: Iterable = ()) -> int:
        return conn.execute(sql, tuple(args)).fetchone()[0]

    return {
        "classes": one("SELECT COUNT(*) FROM nodes WHERE kind IN ('class','interface','enum')"),
        "methods": one("SELECT COUNT(*) FROM nodes WHERE kind = 'method'"),
        "fields": one("SELECT COUNT(*) FROM nodes WHERE kind = 'field'"),
        "endpoints": one("SELECT COUNT(*) FROM nodes WHERE http_method IS NOT NULL"),
        "edges": one("SELECT COUNT(*) FROM edges"),
        "injects": one("SELECT COUNT(*) FROM edges WHERE kind = 'injects'"),
        "routes_to": one("SELECT COUNT(*) FROM edges WHERE kind = 'routes_to'"),
        "features": one("SELECT COUNT(*) FROM features"),
    }
