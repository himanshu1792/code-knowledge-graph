"""JPA / Hibernate awareness pass (deterministic).

Models the persistence layer on top of the generic spine + Spring pass, capturing
not just *that* entities relate, but *how* they are mapped:

  * Entities    — @Entity / @Table classes -> layer "entity"; node ``attrs`` JSON
                  carries the table name and the column mapping of each field
                  (@Id, @GeneratedValue, @Column name/nullable/unique/length,
                  @Enumerated, @Lob, @Version, @Transient, @Embedded).
  * Relations   — @OneToMany / @ManyToOne / @OneToOne / @ManyToMany fields ->
                  edges between entities, with ``attrs`` JSON describing the
                  mapping: cascade, fetch (explicit or JPA default), mappedBy,
                  owning side, orphanRemoval, @JoinColumn, and @JoinTable.
  * Repositories — Spring Data interfaces (JpaRepository<T, ID> & friends) ->
                  layer "repository" + a `persists` edge to the managed entity.

Consumes the ``ClassInfo`` model from ``extract.py`` (no re-parsing). Runs after
the Spring pass so it can refine layers for entities and JPA repositories.
"""

from __future__ import annotations

import json
import re
from typing import Optional

from .extract import Annotation, ClassInfo, FieldInfo, Symbols

RELATION_ANNS = {
    "OneToMany": "one_to_many",
    "ManyToOne": "many_to_one",
    "OneToOne": "one_to_one",
    "ManyToMany": "many_to_many",
}
COLLECTION_RELATIONS = {"one_to_many", "many_to_many"}
# JPA default fetch: *ToOne is EAGER, *ToMany is LAZY.
DEFAULT_FETCH = {
    "one_to_many": "LAZY", "many_to_many": "LAZY",
    "many_to_one": "EAGER", "one_to_one": "EAGER",
}

REPO_BASES = {
    "JpaRepository", "CrudRepository", "PagingAndSortingRepository",
    "ReactiveCrudRepository", "Repository", "JpaSpecificationExecutor",
}

_GENERIC_FIRST = re.compile(r"<\s*([A-Za-z_][A-Za-z0-9_.]*)")


def _simple(name: str) -> str:
    return name.rsplit(".", 1)[-1] if "." in name else name


# --- annotation-argument parsing -----------------------------------------------

def _str_arg(args: str, *keys: str) -> Optional[str]:
    """Return a string argument: name="x" / path="x", or the first bare literal."""
    for k in keys:
        m = re.search(rf'{k}\s*=\s*"([^"]*)"', args)
        if m:
            return m.group(1)
    return None


def _bool_arg(args: str, key: str) -> Optional[bool]:
    m = re.search(rf'{key}\s*=\s*(true|false)', args)
    return (m.group(1) == "true") if m else None


def _int_arg(args: str, key: str) -> Optional[int]:
    m = re.search(rf'{key}\s*=\s*(\d+)', args)
    return int(m.group(1)) if m else None


def _enum_tokens(args: str, enum: str) -> list[str]:
    """All ``Enum.VALUE`` tokens for a given enum name (e.g. CascadeType)."""
    return re.findall(rf'{enum}\.(\w+)', args)


def _table_name(ci: ClassInfo) -> str:
    t = ci.annotation("Table")
    if t and t.args_text:
        return _str_arg(t.args_text, "name") or _table_first_literal(t.args_text) or ci.name
    return ci.name


def _table_first_literal(args: str) -> Optional[str]:
    m = re.search(r'"([^"]+)"', args)
    return m.group(1) if m else None


# --- field column mapping ------------------------------------------------------

def _column_mapping(fld: FieldInfo) -> dict:
    names = {a.name for a in fld.annotations}
    col = fld.annotation("Column")
    join = fld.annotation("JoinColumn")
    gen = fld.annotation("GeneratedValue")

    column_name = None
    if col and col.args_text:
        column_name = _str_arg(col.args_text, "name")
    if not column_name and join and join.args_text:
        column_name = _str_arg(join.args_text, "name")

    m: dict = {
        "field": fld.name,
        "type": fld.type_simple,
        "column": column_name or fld.name,
        "primary_key": bool(names & {"Id", "EmbeddedId"}),
    }
    if gen is not None:
        strat = _enum_tokens(gen.args_text or "", "GenerationType")
        m["generated"] = strat[0] if strat else "AUTO"
    if col and col.args_text:
        nullable = _bool_arg(col.args_text, "nullable")
        unique = _bool_arg(col.args_text, "unique")
        length = _int_arg(col.args_text, "length")
        if nullable is not None:
            m["nullable"] = nullable
        if unique is not None:
            m["unique"] = unique
        if length is not None:
            m["length"] = length
    for flag, ann in (("enumerated", "Enumerated"), ("lob", "Lob"),
                      ("version", "Version"), ("embedded", "Embedded"),
                      ("transient", "Transient")):
        if ann in names:
            m[flag] = True
    return m


# --- relationship mapping ------------------------------------------------------

def _relation_attrs(fld: FieldInfo, rel: str) -> dict:
    rel_ann = next((a for a in fld.annotations if a.name in RELATION_ANNS), None)
    args = rel_ann.args_text if rel_ann else ""
    mapped_by = _str_arg(args, "mappedBy")
    fetch = (_enum_tokens(args, "FetchType") or [None])[0] or DEFAULT_FETCH[rel]
    cascade = _enum_tokens(args, "CascadeType")
    orphan = _bool_arg(args, "orphanRemoval")

    attrs: dict = {
        "field": fld.name,
        "fetch": fetch,
        "fetch_default": not bool(_enum_tokens(args, "FetchType")),
        "owning": mapped_by is None,
    }
    if mapped_by:
        attrs["mapped_by"] = mapped_by
    if cascade:
        attrs["cascade"] = cascade
    if orphan is not None:
        attrs["orphan_removal"] = orphan

    join = fld.annotation("JoinColumn")
    if join is not None:
        attrs["join_column"] = _str_arg(join.args_text or "", "name") or fld.name
        ref = _str_arg(join.args_text or "", "referencedColumnName")
        if ref:
            attrs["referenced_column"] = ref
    join_table = fld.annotation("JoinTable")
    if join_table is not None:
        attrs["join_table"] = _str_arg(join_table.args_text or "", "name")
    return attrs


# --- public api ----------------------------------------------------------------

def is_entity(ci: ClassInfo) -> bool:
    return ci.has_annotation("Entity")


def repository_entity(ci: ClassInfo) -> Optional[str]:
    for raw in ci.raw_supertypes:
        base = _simple(raw.split("<", 1)[0]).strip()
        if base in REPO_BASES and "<" in raw:
            m = _GENERIC_FIRST.search(raw)
            if m:
                return _simple(m.group(1))
    return None


def apply(conn, classes: list[ClassInfo], symbols: Symbols) -> None:
    from . import db

    for ci in classes:
        if is_entity(ci):
            columns = [_column_mapping(f) for f in ci.fields]
            attrs = {"table": _table_name(ci), "columns": columns}
            conn.execute(
                "UPDATE nodes SET layer='entity', signature=?, attrs=? WHERE id=?",
                (f"table={attrs['table']}", json.dumps(attrs), ci.id),
            )
            # also attach the column mapping to the field nodes themselves
            for fld, colmap in zip(ci.fields, columns):
                db.set_node_attrs(conn, f"{ci.id}.{fld.name}", json.dumps(colmap))
            _apply_relations(conn, ci, symbols)

        entity_simple = repository_entity(ci)
        if entity_simple:
            conn.execute("UPDATE nodes SET layer='repository' WHERE id=?", (ci.id,))
            tgt = symbols.resolve(entity_simple, ci)
            if tgt:
                db.add_edge(conn, ci.id, tgt, "persists")

    conn.commit()


def _apply_relations(conn, ci: ClassInfo, symbols: Symbols) -> None:
    from . import db

    for fld in ci.fields:
        rel = next((RELATION_ANNS[a.name] for a in fld.annotations
                    if a.name in RELATION_ANNS), None)
        if rel is None:
            continue

        target_simple = fld.type_simple
        if rel in COLLECTION_RELATIONS and fld.type_raw and "<" in fld.type_raw:
            m = _GENERIC_FIRST.search(fld.type_raw)
            if m:
                target_simple = _simple(m.group(1))

        tgt = symbols.resolve(target_simple, ci)
        if tgt and tgt != ci.id:
            db.add_edge(conn, ci.id, tgt, rel, json.dumps(_relation_attrs(fld, rel)))
