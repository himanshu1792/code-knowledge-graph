"""Deterministic tree-sitter extractor (the generic spine).

Parses Java sources into a rich in-memory model (``ClassInfo`` / ``MethodInfo`` /
``FieldInfo``) and resolves cross-file structural edges (extends / implements /
imports / calls). The Spring pass (``spring.py``) consumes the *same* model to add
endpoints, DI, and layer classification without re-parsing.

tree-sitter 0.25 API:
    from tree_sitter import Language, Parser
    import tree_sitter_java
    parser = Parser(Language(tree_sitter_java.language()))
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Optional

import tree_sitter_java
from tree_sitter import Language, Parser

_PARSER: Optional[Parser] = None


def parser() -> Parser:
    global _PARSER
    if _PARSER is None:
        _PARSER = Parser(Language(tree_sitter_java.language()))
    return _PARSER


# --- model ---------------------------------------------------------------------

@dataclass
class Annotation:
    name: str          # simple name, no '@'
    args_text: str     # raw text inside parentheses, "" if none


@dataclass
class FieldInfo:
    name: str
    type_simple: Optional[str]
    type_raw: Optional[str] = None   # full text incl. generics, e.g. "List<Order>"
    annotations: list[Annotation] = field(default_factory=list)
    start_line: int = 0
    end_line: int = 0

    def annotation(self, name: str) -> Optional["Annotation"]:
        for a in self.annotations:
            if a.name == name:
                return a
        return None


@dataclass
class Invocation:
    receiver: Optional[str]   # identifier text, "this", or None (unqualified)
    method: str


@dataclass
class MethodInfo:
    name: str
    params: list[tuple[str, Optional[str]]]   # (param_name, type_simple)
    return_type: Optional[str]
    annotations: list[Annotation] = field(default_factory=list)
    is_constructor: bool = False
    start_line: int = 0
    end_line: int = 0
    locals: dict[str, str] = field(default_factory=dict)   # var name -> type_simple
    invocations: list[Invocation] = field(default_factory=list)

    def node_id(self, owner_id: str) -> str:
        sig = ",".join(t or "?" for _, t in self.params)
        return f"{owner_id}#{self.name}({sig})"

    def signature(self) -> str:
        ps = ", ".join(f"{t or 'var'} {n}" for n, t in self.params)
        ret = (self.return_type + " ") if self.return_type else ""
        return f"{ret}{self.name}({ps})"


@dataclass
class ClassInfo:
    name: str
    package: str
    file: str            # path relative to indexed root
    kind: str            # class|interface|enum
    annotations: list[Annotation] = field(default_factory=list)
    extends: list[str] = field(default_factory=list)      # simple names
    implements: list[str] = field(default_factory=list)   # simple names
    raw_supertypes: list[str] = field(default_factory=list)  # full text incl. generics
    fields: list[FieldInfo] = field(default_factory=list)
    methods: list[MethodInfo] = field(default_factory=list)
    imports: dict[str, str] = field(default_factory=dict)  # simple -> fqn
    start_line: int = 0
    end_line: int = 0

    @property
    def id(self) -> str:
        return f"{self.package}.{self.name}" if self.package else self.name

    def has_annotation(self, *names: str) -> bool:
        return any(a.name in names for a in self.annotations)

    def annotation(self, name: str) -> Optional[Annotation]:
        for a in self.annotations:
            if a.name == name:
                return a
        return None


# --- low-level node helpers ----------------------------------------------------

def _text(src: bytes, node) -> str:
    return src[node.start_byte:node.end_byte].decode("utf8", "replace")


def _simple_type_name(text: str) -> str:
    """Reduce a type expression to its simple class name.

    ``List<Order>`` -> ``List``; ``com.x.Foo`` -> ``Foo``; ``Order[]`` -> ``Order``.
    """
    t = text.strip()
    if "<" in t:
        t = t[: t.index("<")]
    t = t.replace("[]", "").strip()
    if "." in t:
        t = t.rsplit(".", 1)[1]
    return t


def _annotation_name(text: str) -> str:
    t = text.lstrip("@").strip()
    if "(" in t:
        t = t[: t.index("(")]
    if "." in t:
        t = t.rsplit(".", 1)[1]
    return t.strip()


def _annotations_of(src: bytes, node) -> list[Annotation]:
    """Collect annotations from a node's `modifiers` child, if any.

    In tree-sitter-java the `modifiers` node is an *unnamed* child of class/method
    declarations, and the annotations live inside it — so scan direct children and
    descend into any `modifiers` child.
    """
    out: list[Annotation] = []
    children = list(node.children)
    for ch in node.children:
        if ch.type == "modifiers":
            children.extend(ch.children)
    for ch in children:
        if ch.type in ("marker_annotation", "annotation"):
            name_node = ch.child_by_field_name("name")
            name = _annotation_name(_text(src, name_node) if name_node else _text(src, ch))
            args_node = ch.child_by_field_name("arguments")
            args = _text(src, args_node) if args_node else ""
            if args.startswith("(") and args.endswith(")"):
                args = args[1:-1]
            out.append(Annotation(name=name, args_text=args))
    return out


def _type_names_in(src: bytes, node) -> list[str]:
    """Pull simple type names out of a type_list / superclass / interfaces node."""
    names: list[str] = []
    for ch in node.children:
        if ch.type in ("type_identifier", "scoped_type_identifier", "generic_type"):
            names.append(_simple_type_name(_text(src, ch)))
    return names


def _raw_types_in(src: bytes, node) -> list[str]:
    """Full type texts (generics preserved) from a type_list / superclass node."""
    out: list[str] = []
    for ch in node.children:
        if ch.type in ("type_identifier", "scoped_type_identifier", "generic_type"):
            out.append(_text(src, ch))
    return out


# --- per-file parse ------------------------------------------------------------

def parse_file(abs_path: str, rel_path: str) -> list[ClassInfo]:
    with open(abs_path, "rb") as fh:
        src = fh.read()
    tree = parser().parse(src)
    root = tree.root_node

    package = ""
    imports: dict[str, str] = {}
    for ch in root.children:
        if ch.type == "package_declaration":
            for c in ch.children:
                if c.type in ("scoped_identifier", "identifier"):
                    package = _text(src, c)
        elif ch.type == "import_declaration":
            fqn = None
            for c in ch.children:
                if c.type in ("scoped_identifier", "identifier"):
                    fqn = _text(src, c)
            if fqn and not fqn.endswith("*"):
                imports[fqn.rsplit(".", 1)[-1]] = fqn

    classes: list[ClassInfo] = []
    _walk_types(src, root, package, rel_path, dict(imports), classes)
    return classes


_TYPE_DECLS = {
    "class_declaration": "class",
    "interface_declaration": "interface",
    "enum_declaration": "enum",
}


def _walk_types(src, node, package, rel_path, imports, out: list[ClassInfo]) -> None:
    for ch in node.children:
        if ch.type in _TYPE_DECLS:
            out.append(_parse_type(src, ch, package, rel_path, imports))
            # nested types
            body = ch.child_by_field_name("body")
            if body is not None:
                _walk_types(src, body, package, rel_path, imports, out)
        elif ch.type in ("program",):
            _walk_types(src, ch, package, rel_path, imports, out)


def _parse_type(src, node, package, rel_path, imports) -> ClassInfo:
    name_node = node.child_by_field_name("name")
    name = _text(src, name_node) if name_node else "<anon>"
    ci = ClassInfo(
        name=name,
        package=package,
        file=rel_path,
        kind=_TYPE_DECLS[node.type],
        annotations=_annotations_of(src, node),
        imports=imports,
        start_line=node.start_point[0] + 1,
        end_line=node.end_point[0] + 1,
    )

    # `superclass`, `super_interfaces` (class implements), and `extends_interfaces`
    # (interface extends) are unnamed children — scan by node type, not field name.
    for ch in node.children:
        if ch.type == "superclass":
            ci.extends.extend(_type_names_in(src, ch))
            ci.raw_supertypes.extend(_raw_types_in(src, ch))
        elif ch.type == "super_interfaces":
            for c in ch.children:
                if c.type == "type_list":
                    ci.implements.extend(_type_names_in(src, c))
                    ci.raw_supertypes.extend(_raw_types_in(src, c))
        elif ch.type == "extends_interfaces":
            for c in ch.children:
                if c.type == "type_list":
                    ci.extends.extend(_type_names_in(src, c))
                    ci.raw_supertypes.extend(_raw_types_in(src, c))

    body = next((c for c in node.children
                 if c.type in ("class_body", "interface_body", "enum_body")), None)
    if body is not None:
        for member in body.children:
            if member.type == "field_declaration":
                ci.fields.extend(_parse_field(src, member))
            elif member.type in ("method_declaration", "constructor_declaration"):
                ci.methods.append(_parse_method(src, member))
    return ci


def _parse_field(src, node) -> list[FieldInfo]:
    anns = _annotations_of(src, node)
    type_node = node.child_by_field_name("type")
    type_simple = _simple_type_name(_text(src, type_node)) if type_node else None
    type_raw = _text(src, type_node) if type_node else None
    out: list[FieldInfo] = []
    for ch in node.children:
        if ch.type == "variable_declarator":
            n = ch.child_by_field_name("name")
            if n is not None:
                out.append(FieldInfo(
                    name=_text(src, n),
                    type_simple=type_simple,
                    type_raw=type_raw,
                    annotations=anns,
                    start_line=node.start_point[0] + 1,
                    end_line=node.end_point[0] + 1,
                ))
    return out


def _parse_method(src, node) -> MethodInfo:
    is_ctor = node.type == "constructor_declaration"
    name_node = node.child_by_field_name("name")
    name = _text(src, name_node) if name_node else "<init>"
    ret_node = node.child_by_field_name("type")
    ret = _simple_type_name(_text(src, ret_node)) if (ret_node and not is_ctor) else None

    params: list[tuple[str, Optional[str]]] = []
    params_node = node.child_by_field_name("parameters")
    if params_node is not None:
        for p in params_node.children:
            if p.type in ("formal_parameter", "spread_parameter"):
                pt = p.child_by_field_name("type")
                pn = p.child_by_field_name("name")
                params.append((
                    _text(src, pn) if pn else "?",
                    _simple_type_name(_text(src, pt)) if pt else None,
                ))

    mi = MethodInfo(
        name=name,
        params=params,
        return_type=ret,
        annotations=_annotations_of(src, node),
        is_constructor=is_ctor,
        start_line=node.start_point[0] + 1,
        end_line=node.end_point[0] + 1,
    )

    body = node.child_by_field_name("body")
    if body is not None:
        _scan_body(src, body, mi)
    return mi


def _scan_body(src, node, mi: MethodInfo) -> None:
    """Recursively collect local var declarations and method invocations."""
    if node.type == "local_variable_declaration":
        type_node = node.child_by_field_name("type")
        type_simple = _simple_type_name(_text(src, type_node)) if type_node else None
        for ch in node.children:
            if ch.type == "variable_declarator":
                n = ch.child_by_field_name("name")
                if n is not None and type_simple:
                    mi.locals[_text(src, n)] = type_simple
    elif node.type == "method_invocation":
        name_node = node.child_by_field_name("name")
        obj_node = node.child_by_field_name("object")
        receiver = None
        if obj_node is not None:
            if obj_node.type == "identifier":
                receiver = _text(src, obj_node)
            elif obj_node.type == "this":
                receiver = "this"
        if name_node is not None:
            mi.invocations.append(Invocation(receiver=receiver, method=_text(src, name_node)))

    for ch in node.children:
        _scan_body(src, ch, mi)


# --- repo walk + resolution ----------------------------------------------------

def discover_java_files(root: str) -> list[str]:
    out: list[str] = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in (".git", "target", "build", ".code-kg")]
        for fn in filenames:
            if fn.endswith(".java") and not fn.endswith("package-info.java"):
                out.append(os.path.join(dirpath, fn))
    return sorted(out)


class Symbols:
    """Repo-wide simple-name -> fqn resolution table."""

    def __init__(self, classes: list[ClassInfo]):
        self.by_id: dict[str, ClassInfo] = {c.id: c for c in classes}
        self.by_simple: dict[str, list[str]] = {}
        for c in classes:
            self.by_simple.setdefault(c.name, []).append(c.id)

    def resolve(self, simple: Optional[str], ctx: ClassInfo) -> Optional[str]:
        if not simple:
            return None
        # explicit import wins
        if simple in ctx.imports:
            fqn = ctx.imports[simple]
            if fqn in self.by_id:
                return fqn
        # same package
        same = f"{ctx.package}.{simple}" if ctx.package else simple
        if same in self.by_id:
            return same
        # repo-wide unique simple name
        cand = self.by_simple.get(simple)
        if cand and len(cand) == 1:
            return cand[0]
        return None

    def methods_named(self, class_id: str, name: str) -> list[str]:
        ci = self.by_id.get(class_id)
        if ci is None:
            return []
        return [m.node_id(class_id) for m in ci.methods if m.name == name]


def parse_repo(root: str) -> tuple[list[ClassInfo], Symbols]:
    """Parse every Java file under ``root`` into the model + symbol table."""
    classes: list[ClassInfo] = []
    for abs_path in discover_java_files(root):
        rel = os.path.relpath(abs_path, root)
        classes.extend(parse_file(abs_path, rel))
    return classes, Symbols(classes)


# --- write the generic spine into SQLite --------------------------------------

def write_structure(conn, classes: list[ClassInfo], symbols: Symbols) -> None:
    """Write class/method/field nodes and structural edges.

    Structural edges: extends, implements, imports, calls. (Spring-specific
    edges — injects, routes_to — and layer/endpoint columns are added by the
    Spring pass.)
    """
    from . import db

    for ci in classes:
        db.upsert_node(conn, {
            "id": ci.id,
            "kind": ci.kind,
            "name": ci.name,
            "file": ci.file,
            "package": ci.package,
            "signature": None,
            "start_line": ci.start_line,
            "end_line": ci.end_line,
            "annotations": ",".join(a.name for a in ci.annotations) or None,
            "layer": None,
            "http_method": None,
            "path": None,
            "summary": None,
            "attrs": None,
        })
        for fi in ci.fields:
            db.upsert_node(conn, {
                "id": f"{ci.id}.{fi.name}",
                "kind": "field",
                "name": fi.name,
                "file": ci.file,
                "package": ci.package,
                "signature": fi.type_simple,
                "start_line": fi.start_line,
                "end_line": fi.end_line,
                "annotations": ",".join(a.name for a in fi.annotations) or None,
                "layer": None,
                "http_method": None,
                "path": None,
                "summary": None,
            })
        for mi in ci.methods:
            db.upsert_node(conn, {
                "id": mi.node_id(ci.id),
                "kind": "method",
                "name": mi.name,
                "file": ci.file,
                "package": ci.package,
                "signature": mi.signature(),
                "start_line": mi.start_line,
                "end_line": mi.end_line,
                "annotations": ",".join(a.name for a in mi.annotations) or None,
                "layer": None,
                "http_method": None,
                "path": None,
                "summary": None,
            })

    # structural edges
    for ci in classes:
        for sup in ci.extends:
            tgt = symbols.resolve(sup, ci)
            if tgt:
                db.add_edge(conn, ci.id, tgt, "extends")
        for itf in ci.implements:
            tgt = symbols.resolve(itf, ci)
            if tgt:
                db.add_edge(conn, ci.id, tgt, "implements")
        for simple, fqn in ci.imports.items():
            if fqn in symbols.by_id:
                db.add_edge(conn, ci.id, fqn, "imports")
        _write_calls(conn, ci, symbols)

    conn.commit()


def _write_calls(conn, ci: ClassInfo, symbols: Symbols) -> None:
    from . import db

    for mi in ci.methods:
        caller = mi.node_id(ci.id)
        # variable type environment for receiver resolution
        env: dict[str, str] = {}
        for fld in ci.fields:
            if fld.type_simple:
                env[fld.name] = fld.type_simple
        for pname, ptype in mi.params:
            if ptype:
                env[pname] = ptype
        env.update(mi.locals)

        for inv in mi.invocations:
            target_type_simple: Optional[str] = None
            if inv.receiver is None or inv.receiver == "this":
                target_type_simple = ci.name
            elif inv.receiver in env:
                target_type_simple = env[inv.receiver]
            else:
                # possibly a static call on a class simple name
                target_type_simple = inv.receiver

            target_id = symbols.resolve(target_type_simple, ci)
            if not target_id:
                continue
            method_ids = symbols.methods_named(target_id, inv.method)
            if method_ids:
                for mid in method_ids:
                    db.add_edge(conn, caller, mid, "calls")
            else:
                db.add_edge(conn, caller, target_id, "calls")
