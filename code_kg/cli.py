"""code-kg command line: index | reindex | enrich | serve | digest."""

from __future__ import annotations

import argparse
import os
import sys
import time
from typing import Optional

from . import db, extract, jpa, spring


# --- helpers -------------------------------------------------------------------

def find_repo_root(path: str) -> str:
    """Walk up from ``path`` to find a git repo root; fall back to ``path``."""
    cur = os.path.abspath(path)
    if os.path.isfile(cur):
        cur = os.path.dirname(cur)
    while True:
        if os.path.isdir(os.path.join(cur, ".git")):
            return cur
        parent = os.path.dirname(cur)
        if parent == cur:
            return os.path.abspath(path)
        cur = parent


def _file_signature(root: str) -> dict:
    sig = {}
    for p in extract.discover_java_files(root):
        try:
            sig[os.path.relpath(p, root)] = os.path.getmtime(p)
        except OSError:
            pass
    return sig


def build_graph(conn, source_root: str) -> dict:
    """Full (re)build: parse → structure → spring → fallback features."""
    classes, symbols = extract.parse_repo(source_root)
    db.reset(conn)
    extract.write_structure(conn, classes, symbols)
    spring.apply(conn, classes, symbols)
    jpa.apply(conn, classes, symbols)
    spring.build_fallback_features(conn)

    db.set_meta(conn, "source_root", os.path.abspath(source_root))
    db.set_meta(conn, "indexed_at", str(int(time.time())))
    import json
    db.set_meta(conn, "file_mtimes", json.dumps(_file_signature(source_root)))
    conn.commit()
    return db.counts(conn)


def _resolve_repo_db(repo: Optional[str], db_path: Optional[str]) -> tuple[str, str]:
    repo = repo or os.getcwd()
    repo_root = find_repo_root(repo)
    return repo_root, db.resolve_db_path(repo_root, db_path)


# --- commands ------------------------------------------------------------------

def cmd_index(args) -> int:
    source = os.path.abspath(args.path)
    repo_root = find_repo_root(source)
    db_file = db.resolve_db_path(repo_root, args.db)
    conn = db.connect(db_file)
    db.init_schema(conn)
    counts = build_graph(conn, source)
    conn.close()
    print(f"Indexed {source}")
    print(f"  graph.db: {db_file}")
    _print_counts(counts)
    return 0


def cmd_reindex(args) -> int:
    repo_root, db_file = _resolve_repo_db(args.repo, args.db)
    if not os.path.exists(db_file):
        print(f"No graph at {db_file}; run `code-kg index <path>` first.", file=sys.stderr)
        return 1
    conn = db.connect(db_file)
    db.init_schema(conn)
    source_root = db.get_meta(conn, "source_root")
    if args.path:
        source_root = os.path.abspath(args.path)
    if not source_root:
        print("No source root recorded; pass a path: `code-kg reindex <path>`", file=sys.stderr)
        return 1

    import json
    old = json.loads(db.get_meta(conn, "file_mtimes") or "{}")
    new = _file_signature(source_root)
    changed = sorted(set(old) ^ set(new)) + sorted(
        f for f in (set(old) & set(new)) if old[f] != new[f]
    )

    counts = build_graph(conn, source_root)
    conn.close()
    if changed:
        print(f"Reindexed; {len(changed)} file(s) changed:")
        for f in changed[:20]:
            print(f"  - {f}")
    else:
        print("Reindexed; no file changes detected.")
    _print_counts(counts)
    return 0


def cmd_enrich(args) -> int:
    from . import enrich
    repo_root, db_file = _resolve_repo_db(args.repo, args.db)
    if not os.path.exists(db_file):
        print(f"No graph at {db_file}; run `code-kg index <path>` first.", file=sys.stderr)
        return 1
    conn = db.connect(db_file)
    db.init_schema(conn)
    try:
        report = enrich.enrich(conn, model=args.model, api_key=args.api_key)
    except RuntimeError as e:
        print(f"Enrichment skipped: {e}", file=sys.stderr)
        conn.close()
        return 1
    conn.close()
    print(f"Enrichment complete: {report['features_written']} feature(s) written, "
          f"{report['features_rejected']} rejected by anti-hallucination gate.")
    return 0


def cmd_serve(args) -> int:
    from . import server
    repo_root, db_file = _resolve_repo_db(args.repo, args.db)
    if not os.path.exists(db_file):
        print(f"No graph at {db_file}; run `code-kg index <path>` first.", file=sys.stderr)
        return 1
    server.serve(db_file)
    return 0


def cmd_digest(args) -> int:
    repo_root, db_file = _resolve_repo_db(args.repo, args.db)
    if not os.path.exists(db_file):
        print(f"No graph at {db_file}; run `code-kg index <path>` first.", file=sys.stderr)
        return 1
    conn = db.connect(db_file)
    db.init_schema(conn)
    text = render_digest(conn)
    conn.close()
    if args.output:
        with open(args.output, "w") as fh:
            fh.write(text)
        print(f"Wrote {args.output}")
    else:
        print(text)
    return 0


# --- digest rendering ----------------------------------------------------------

def render_digest(conn) -> str:
    counts = db.counts(conn)
    lines: list[str] = []
    lines.append("# Architecture (code-kg digest)")
    lines.append("")
    lines.append("> Generated from the code knowledge graph (`.code-kg/graph.db`). "
                 "Derived deterministically from source — not hand-written.")
    lines.append("")
    lines.append("## Overview")
    lines.append("")
    lines.append(f"- Classes/interfaces/enums: **{counts['classes']}**")
    lines.append(f"- Methods: **{counts['methods']}**")
    lines.append(f"- HTTP endpoints: **{counts['endpoints']}**")
    lines.append(f"- DI (injects) edges: **{counts['injects']}**")
    lines.append(f"- Total edges: **{counts['edges']}**")
    lines.append("")

    # layered overview
    lines.append("## Layers")
    lines.append("")
    rows = conn.execute(
        "SELECT layer, COUNT(*) c FROM nodes "
        "WHERE kind IN ('class','interface','enum') AND layer IS NOT NULL "
        "GROUP BY layer ORDER BY c DESC"
    ).fetchall()
    for r in rows:
        names = conn.execute(
            "SELECT name FROM nodes WHERE layer = ? AND kind IN ('class','interface','enum') "
            "ORDER BY name", (r["layer"],)
        ).fetchall()
        lines.append(f"- **{r['layer']}** ({r['c']}): " + ", ".join(n["name"] for n in names))
    lines.append("")

    # endpoints
    lines.append("## HTTP Endpoints")
    lines.append("")
    eps = conn.execute(
        "SELECT http_method, path, name, file FROM nodes "
        "WHERE http_method IS NOT NULL ORDER BY path"
    ).fetchall()
    if eps:
        lines.append("| Method | Path | Handler | File |")
        lines.append("|---|---|---|---|")
        for e in eps:
            lines.append(f"| {e['http_method']} | `{e['path']}` | {e['name']} | "
                         f"`{os.path.basename(e['file'])}` |")
    lines.append("")

    # DI edges
    lines.append("## Dependency Injection")
    lines.append("")
    di = conn.execute(
        "SELECT s.name src, d.name dst FROM edges e "
        "JOIN nodes s ON s.id = e.src JOIN nodes d ON d.id = e.dst "
        "WHERE e.kind = 'injects' ORDER BY s.name, d.name"
    ).fetchall()
    for r in di:
        lines.append(f"- `{r['src']}` → `{r['dst']}`")
    lines.append("")

    # data model (JPA / Hibernate)
    entities = conn.execute(
        "SELECT name, signature FROM nodes WHERE layer='entity' "
        "AND kind IN ('class','interface','enum') ORDER BY name"
    ).fetchall()
    if entities:
        lines.append("## Data Model (JPA / Hibernate)")
        lines.append("")
        lines.append("| Entity | Table |")
        lines.append("|---|---|")
        for e in entities:
            table = e["signature"][6:] if (e["signature"] or "").startswith("table=") else ""
            lines.append(f"| {e['name']} | `{table}` |")
        lines.append("")
        rels = conn.execute(
            "SELECT s.name s, d.name d, e.kind k FROM edges e "
            "JOIN nodes s ON s.id=e.src JOIN nodes d ON d.id=e.dst "
            "WHERE e.kind IN ('one_to_many','many_to_one','one_to_one','many_to_many') "
            "ORDER BY s.name"
        ).fetchall()
        if rels:
            lines.append("**Relationships**")
            lines.append("")
            for r in rels:
                lines.append(f"- `{r['s']}` —{r['k']}→ `{r['d']}`")
            lines.append("")
        repos = conn.execute(
            "SELECT s.name s, d.name d FROM edges e "
            "JOIN nodes s ON s.id=e.src JOIN nodes d ON d.id=e.dst "
            "WHERE e.kind='persists' ORDER BY s.name"
        ).fetchall()
        if repos:
            lines.append("**Repositories**")
            lines.append("")
            for r in repos:
                lines.append(f"- `{r['s']}` manages `{r['d']}`")
            lines.append("")

    # features
    feats = conn.execute("SELECT id, name, description FROM features ORDER BY name").fetchall()
    if feats:
        lines.append("## Features")
        lines.append("")
        for f in feats:
            files = conn.execute(
                "SELECT DISTINCT file FROM feature_files WHERE feature_id = ? ORDER BY file",
                (f["id"],)
            ).fetchall()
            lines.append(f"### {f['name']}")
            if f["description"]:
                lines.append("")
                lines.append(f["description"])
            lines.append("")
            for ff in files:
                lines.append(f"- `{ff['file']}`")
            lines.append("")

    return "\n".join(lines)


def _print_counts(counts: dict) -> None:
    print(f"  classes={counts['classes']} methods={counts['methods']} "
          f"endpoints={counts['endpoints']} injects={counts['injects']} "
          f"routes_to={counts['routes_to']} edges={counts['edges']} "
          f"features={counts['features']}")


# --- arg parsing ---------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="code-kg", description=__doc__)
    sub = p.add_subparsers(dest="cmd", required=True)

    pi = sub.add_parser("index", help="full index of a source tree")
    pi.add_argument("path", help="path to source root (e.g. <repo>/src/main/java)")
    pi.add_argument("--db", help="explicit graph.db path")
    pi.set_defaults(func=cmd_index)

    pr = sub.add_parser("reindex", help="incremental re-index (detect changed files)")
    pr.add_argument("path", nargs="?", help="source root (defaults to last-indexed)")
    pr.add_argument("--repo", help="repo root (to locate graph.db)")
    pr.add_argument("--db", help="explicit graph.db path")
    pr.set_defaults(func=cmd_reindex)

    pe = sub.add_parser("enrich", help="optional LLM enrichment pass")
    pe.add_argument("--repo", help="repo root (to locate graph.db)")
    pe.add_argument("--db", help="explicit graph.db path")
    pe.add_argument("--model", default="claude-haiku-4-5", help="Claude model id")
    pe.add_argument("--api-key", help="Anthropic API key (else $ANTHROPIC_API_KEY)")
    pe.set_defaults(func=cmd_enrich)

    ps = sub.add_parser("serve", help="run the MCP server over the graph")
    ps.add_argument("--repo", help="repo root (to locate graph.db)")
    ps.add_argument("--db", help="explicit graph.db path")
    ps.set_defaults(func=cmd_serve)

    pd = sub.add_parser("digest", help="render an ARCHITECTURE.md digest")
    pd.add_argument("--repo", help="repo root (to locate graph.db)")
    pd.add_argument("--db", help="explicit graph.db path")
    pd.add_argument("-o", "--output", help="write to a file instead of stdout")
    pd.set_defaults(func=cmd_digest)

    return p


def main(argv: Optional[list[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
