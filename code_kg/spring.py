"""Spring-awareness pass (deterministic).

Adds what generic structural extraction misses:
  * Endpoints      — @GetMapping/@PostMapping/... + class-level @RequestMapping
                     prefix, resolved to the handler method (http_method/path
                     columns + routes_to edge from the controller class).
  * DI edges       — constructor-injected params and @Autowired fields -> injects.
  * Layer          — @RestController/@Controller -> controller, @Service -> service,
                     @Repository -> repository, etc.; package-based fallback.

Consumes the ``ClassInfo`` model produced by ``extract.py`` (no re-parsing).
"""

from __future__ import annotations

import re
from typing import Optional

from .extract import ClassInfo, Symbols

MAPPING_METHOD = {
    "GetMapping": "GET",
    "PostMapping": "POST",
    "PutMapping": "PUT",
    "DeleteMapping": "DELETE",
    "PatchMapping": "PATCH",
}

CONTROLLER_ANNS = {"RestController", "Controller"}


def _path_from_args(args_text: str) -> str:
    """Extract the path literal from a mapping annotation's argument text.

    Handles `("/x")`, `(value="/x")`, `(path="/x")`, and bare/empty forms.
    """
    if not args_text:
        return ""
    # value="/x" or path="/x"
    m = re.search(r'(?:value|path)\s*=\s*"([^"]*)"', args_text)
    if m:
        return m.group(1)
    # first bare string literal
    m = re.search(r'"([^"]*)"', args_text)
    if m:
        return m.group(1)
    return ""


def _join(prefix: str, path: str) -> str:
    a = "/" + prefix.strip("/") if prefix.strip("/") else ""
    b = "/" + path.strip("/") if path.strip("/") else ""
    joined = (a + b) or "/"
    return joined


def classify_layer(ci: ClassInfo) -> Optional[str]:
    if ci.has_annotation(*CONTROLLER_ANNS):
        return "controller"
    if ci.has_annotation("Service"):
        return "service"
    if ci.has_annotation("Repository"):
        return "repository"
    if ci.has_annotation("Configuration"):
        return "config"
    if ci.has_annotation("SpringBootApplication"):
        return "app"
    if ci.has_annotation("Component"):
        return "component"
    # package-based fallback
    pkg = ci.package.rsplit(".", 1)[-1] if ci.package else ""
    if pkg in ("dao",):
        return "dao"
    if pkg in ("model", "entity", "domain", "dto"):
        return "model"
    if pkg in ("util", "utils", "helper", "helpers"):
        return "util"
    if pkg in ("repository", "repo"):
        return "repository"
    if pkg in ("config",):
        return "config"
    return None


def apply(conn, classes: list[ClassInfo], symbols: Symbols) -> None:
    from . import db

    for ci in classes:
        layer = classify_layer(ci)
        if layer:
            conn.execute("UPDATE nodes SET layer = ? WHERE id = ?", (layer, ci.id))

        _apply_endpoints(conn, ci)
        _apply_di(conn, ci, symbols)

    conn.commit()


def _apply_endpoints(conn, ci: ClassInfo) -> None:
    from . import db

    if not ci.has_annotation(*CONTROLLER_ANNS):
        return
    class_rm = ci.annotation("RequestMapping")
    prefix = _path_from_args(class_rm.args_text) if class_rm else ""

    for mi in ci.methods:
        http_method = None
        path = None
        for ann in mi.annotations:
            if ann.name in MAPPING_METHOD:
                http_method = MAPPING_METHOD[ann.name]
                path = _path_from_args(ann.args_text)
                break
            if ann.name == "RequestMapping":
                m = re.search(r'method\s*=\s*RequestMethod\.(\w+)', ann.args_text)
                http_method = m.group(1) if m else "GET"
                path = _path_from_args(ann.args_text)
                break
        if http_method is None:
            continue
        full = _join(prefix, path or "")
        mid = mi.node_id(ci.id)
        conn.execute(
            "UPDATE nodes SET http_method = ?, path = ? WHERE id = ?",
            (http_method, full, mid),
        )
        db.add_edge(conn, ci.id, mid, "routes_to")


def _apply_di(conn, ci: ClassInfo, symbols: Symbols) -> None:
    from . import db

    targets: set[str] = set()

    # @Autowired fields
    for fld in ci.fields:
        if any(a.name == "Autowired" for a in fld.annotations):
            tgt = symbols.resolve(fld.type_simple, ci)
            if tgt:
                targets.add(tgt)

    # constructor-injected params (single ctor, or @Autowired ctor)
    ctors = [m for m in ci.methods if m.is_constructor]
    chosen = None
    if len(ctors) == 1:
        chosen = ctors[0]
    else:
        for c in ctors:
            if any(a.name == "Autowired" for a in c.annotations):
                chosen = c
                break
    if chosen is not None:
        for _pname, ptype in chosen.params:
            tgt = symbols.resolve(ptype, ci)
            if tgt:
                targets.add(tgt)

    for tgt in targets:
        if tgt != ci.id:
            db.add_edge(conn, ci.id, tgt, "injects")


def build_fallback_features(conn) -> None:
    """Deterministic feature map: one feature per controller, files = the
    controller + everything reachable from it via injects/calls/routes_to.

    Used when the LLM enrichment pass is skipped. Idempotent.
    """
    conn.execute("DELETE FROM feature_files")
    conn.execute("DELETE FROM features WHERE id LIKE 'auto:%'")

    controllers = conn.execute(
        "SELECT id, name, file FROM nodes WHERE layer = 'controller' AND kind != 'method'"
    ).fetchall()

    # adjacency for downstream traversal
    edges = conn.execute(
        "SELECT src, dst, kind FROM edges WHERE kind IN ('injects','calls','routes_to')"
    ).fetchall()
    adj: dict[str, list[str]] = {}
    for e in edges:
        adj.setdefault(e["src"], []).append(e["dst"])

    node_file = {r["id"]: r["file"] for r in conn.execute("SELECT id, file FROM nodes")}

    def owner_class(node_id: str) -> str:
        return node_id.split("#", 1)[0]

    for ctrl in controllers:
        fid = f"auto:{ctrl['id']}"
        name = ctrl["name"].replace("Controller", "") or ctrl["name"]
        conn.execute(
            "INSERT OR REPLACE INTO features (id, name, description) VALUES (?, ?, ?)",
            (fid, name, f"Capabilities exposed by {ctrl['name']}"),
        )
        # BFS from the controller
        seen: set[str] = set()
        stack = [ctrl["id"]]
        while stack:
            cur = stack.pop()
            if cur in seen:
                continue
            seen.add(cur)
            for nxt in adj.get(cur, []):
                if nxt not in seen:
                    stack.append(nxt)
                # also pull the owning class of method targets
                oc = owner_class(nxt)
                if oc not in seen and oc in node_file:
                    stack.append(oc)

        files_added: set[str] = set()
        for nid in seen:
            f = node_file.get(nid) or node_file.get(owner_class(nid))
            if f and f not in files_added:
                files_added.add(f)
                conn.execute(
                    "INSERT OR IGNORE INTO feature_files (feature_id, file, entry_node_id) "
                    "VALUES (?, ?, ?)",
                    (fid, f, ctrl["id"]),
                )
    conn.commit()
