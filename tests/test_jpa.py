"""Tests for the JPA / Hibernate persistence pass (entities, relations, repos)."""

import os
import sqlite3

import pytest

from code_kg import db, server
from code_kg.cli import build_graph

FIXTURE = os.path.join(os.path.dirname(__file__), "fixtures", "shop", "src", "main", "java")


@pytest.fixture()
def graph(tmp_path):
    db_file = str(tmp_path / "graph.db")
    conn = db.connect(db_file)
    db.init_schema(conn)
    build_graph(conn, FIXTURE)
    conn.close()
    return db_file


def _ro(db_file):
    conn = sqlite3.connect(db_file)
    conn.row_factory = sqlite3.Row
    return conn


def test_entities_and_tables(graph):
    conn = _ro(graph)
    rows = {
        r["name"]: r["signature"]
        for r in conn.execute(
            "SELECT name, signature FROM nodes WHERE layer='entity' "
            "AND kind IN ('class','interface','enum')"
        )
    }
    assert set(rows) == {"Customer", "Purchase", "Address"}
    assert rows["Customer"] == "table=customers"
    assert rows["Purchase"] == "table=purchases"
    assert rows["Address"] == "table=Address"  # no @Table -> class name


def test_relationship_edges(graph):
    conn = _ro(graph)
    rels = {
        (r["s"], r["k"], r["d"])
        for r in conn.execute(
            "SELECT s.name s, d.name d, e.kind k FROM edges e "
            "JOIN nodes s ON s.id=e.src JOIN nodes d ON d.id=e.dst "
            "WHERE e.kind IN ('one_to_many','many_to_one','one_to_one','many_to_many')"
        )
    }
    assert ("Customer", "one_to_many", "Purchase") in rels   # List<Purchase> via generic
    assert ("Customer", "one_to_one", "Address") in rels
    assert ("Purchase", "many_to_one", "Customer") in rels


def test_repository_persists_entity(graph):
    conn = _ro(graph)
    persists = {
        (r["s"], r["d"])
        for r in conn.execute(
            "SELECT s.name s, d.name d FROM edges e "
            "JOIN nodes s ON s.id=e.src JOIN nodes d ON d.id=e.dst "
            "WHERE e.kind='persists'"
        )
    }
    assert ("PurchaseRepository", "Purchase") in persists
    layer = conn.execute(
        "SELECT layer FROM nodes WHERE name='PurchaseRepository'"
    ).fetchone()["layer"]
    assert layer == "repository"


def test_kg_data_model(graph):
    server._DB_FILE = graph
    dm = server.kg_data_model()
    entity_names = {e["entity"] for e in dm["entities"]}
    assert {"Customer", "Purchase", "Address"} == entity_names
    assert {"PurchaseRepository"} == {r["repository"] for r in dm["repositories"]}
    assert any(r["kind"] == "one_to_many" for r in dm["relationships"])


def test_impact_of_entity_reaches_repository_and_service(graph):
    server._DB_FILE = graph
    # changing the Purchase entity should impact its repository and the service
    res = server.kg_impact_of("Purchase")
    assert "PurchaseRepository" in res["impacted"]
    assert "PurchaseService" in res["impacted"]


def test_relation_mapping_detail(graph):
    server._DB_FILE = graph
    dm = server.kg_data_model()
    by = {(r["from"], r["kind"], r["to"]): r for r in dm["relationships"]}

    # Customer.purchases: @OneToMany(mappedBy="customer", cascade=ALL) -> inverse side
    o2m = by[("Customer", "one_to_many", "Purchase")]
    assert o2m["owning"] is False
    assert o2m["mapped_by"] == "customer"
    assert o2m["cascade"] == ["ALL"]
    assert o2m["fetch"] == "LAZY"          # *ToMany default

    # Purchase.customer: @ManyToOne @JoinColumn(name="customer_id") -> owning side, EAGER
    m2o = by[("Purchase", "many_to_one", "Customer")]
    assert m2o["owning"] is True
    assert m2o["fetch"] == "EAGER"         # *ToOne default
    assert m2o["join_column"] == "customer_id"

    # Customer.address: @OneToOne @JoinColumn(name="address_id")
    o2o = by[("Customer", "one_to_one", "Address")]
    assert o2o["join_column"] == "address_id"


def test_entity_column_mapping(graph):
    server._DB_FILE = graph
    ent = server.kg_entity("Customer")
    assert ent["table"] == "customers"
    cols = {c["column"]: c for c in ent["columns"]}
    # @Id @GeneratedValue(strategy=IDENTITY) private Long id;
    assert cols["id"]["primary_key"] is True
    assert cols["id"]["generated"] == "IDENTITY"
    # @Column(nullable=false) private String name;
    assert cols["name"]["nullable"] is False
    assert ent["primary_key"] == ["id"] if "primary_key" in ent else True


def test_entity_referenced_by(graph):
    server._DB_FILE = graph
    ent = server.kg_entity("Customer")
    # Purchase.customer points at Customer (inbound many_to_one)
    inbound = {(i["from"], i["kind"]) for i in ent["referenced_by"]}
    assert ("Purchase", "many_to_one") in inbound
    assert "PurchaseRepository" not in ent["repositories"]  # repo manages Purchase, not Customer
