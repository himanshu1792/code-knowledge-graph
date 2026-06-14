"""JPA / Hibernate awareness pass (deterministic).

Adds the persistence layer on top of the generic spine + Spring pass:
  * Entities    — @Entity / @Table classes -> layer "entity"; table name captured
                  in the node's signature column as "table=<name>".
  * Relations   — @OneToMany / @ManyToOne / @OneToOne / @ManyToMany fields ->
                  edges between entity classes (kind = one_to_many / many_to_one /
                  one_to_one / many_to_many). Collection element type is resolved
                  from the generic argument (List<Order> -> Order).
  * Repositories — interfaces extending Spring Data's JpaRepository<T, ID> (and
                  friends) -> layer "repository" + a `persists` edge to entity T.

Consumes the ``ClassInfo`` model from ``extract.py`` (no re-parsing). Runs after
the Spring pass so it can refine layers for entities and JPA repositories.
"""

from __future__ import annotations

import re
from typing import Optional

from .extract import ClassInfo, Symbols

RELATION_ANNS = {
    "OneToMany": "one_to_many",
    "ManyToOne": "many_to_one",
    "OneToOne": "one_to_one",
    "ManyToMany": "many_to_many",
}

COLLECTION_RELATIONS = {"one_to_many", "many_to_many"}

# Spring Data repository base interfaces; first generic arg is the managed entity.
REPO_BASES = {
    "JpaRepository",
    "CrudRepository",
    "PagingAndSortingRepository",
    "ReactiveCrudRepository",
    "Repository",
    "JpaSpecificationExecutor",
}

_GENERIC_FIRST = re.compile(r"<\s*([A-Za-z_][A-Za-z0-9_.]*)")
_GENERIC_ALL = re.compile(r"<\s*([A-Za-z_][A-Za-z0-9_.]*)")


def _simple(name: str) -> str:
    return name.rsplit(".", 1)[-1] if "." in name else name


def _table_name(ci: ClassInfo) -> str:
    """Resolve the table name: @Table(name=...) > @Table("...") > class name."""
    t = ci.annotation("Table")
    if t and t.args_text:
        m = re.search(r'name\s*=\s*"([^"]+)"', t.args_text) or re.search(r'"([^"]+)"', t.args_text)
        if m:
            return m.group(1)
    return ci.name


def is_entity(ci: ClassInfo) -> bool:
    return ci.has_annotation("Entity")


def repository_entity(ci: ClassInfo) -> Optional[str]:
    """If ``ci`` is a Spring Data repository, return the managed entity simple name."""
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
        # entities
        if is_entity(ci):
            conn.execute(
                "UPDATE nodes SET layer = 'entity', signature = ? WHERE id = ?",
                (f"table={_table_name(ci)}", ci.id),
            )
            _apply_relations(conn, ci, symbols)

        # spring data repositories
        entity_simple = repository_entity(ci)
        if entity_simple:
            conn.execute("UPDATE nodes SET layer = 'repository' WHERE id = ?", (ci.id,))
            tgt = symbols.resolve(entity_simple, ci)
            if tgt:
                db.add_edge(conn, ci.id, tgt, "persists")

    conn.commit()


def _apply_relations(conn, ci: ClassInfo, symbols: Symbols) -> None:
    from . import db

    for fld in ci.fields:
        rel = None
        for ann in fld.annotations:
            if ann.name in RELATION_ANNS:
                rel = RELATION_ANNS[ann.name]
                break
        if rel is None:
            continue

        # resolve the target entity simple name
        target_simple = fld.type_simple
        if rel in COLLECTION_RELATIONS and fld.type_raw and "<" in fld.type_raw:
            m = _GENERIC_FIRST.search(fld.type_raw)
            if m:
                target_simple = _simple(m.group(1))

        tgt = symbols.resolve(target_simple, ci)
        if tgt and tgt != ci.id:
            db.add_edge(conn, ci.id, tgt, rel)
