"""End-to-end tests against the bundled Java fixture.

Mirrors the verification plan (§7 of the build spec) at fixture scale: the
extractor reconciles classes / endpoints / DI edges, the MCP tools answer
correctly, and the anti-hallucination gate rejects bad enrichment writes.
"""

import os
import sqlite3

import pytest

from code_kg import db, enrich, server
from code_kg.cli import build_graph

FIXTURE = os.path.join(os.path.dirname(__file__), "fixtures", "demo", "src", "main", "java")


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


# --- extractor reconciles ground truth -----------------------------------------

def test_class_count(graph):
    conn = _ro(graph)
    n = conn.execute(
        "SELECT COUNT(*) FROM nodes WHERE kind IN ('class','interface','enum')"
    ).fetchone()[0]
    assert n == 9


def test_endpoints(graph):
    conn = _ro(graph)
    eps = {
        (r["http_method"], r["path"])
        for r in conn.execute(
            "SELECT http_method, path FROM nodes WHERE http_method IS NOT NULL"
        )
    }
    assert eps == {
        ("GET", "/api/orders/sorted"),
        ("GET", "/api/orders/discount/{tier}"),
        ("GET", "/api/greet/{name}"),
        ("POST", "/api/transform"),
    }


def test_injects_edges(graph):
    conn = _ro(graph)
    di = {
        (r["s"], r["d"])
        for r in conn.execute(
            "SELECT s.name s, d.name d FROM edges e "
            "JOIN nodes s ON s.id=e.src JOIN nodes d ON d.id=e.dst "
            "WHERE e.kind='injects'"
        )
    }
    assert di == {
        ("OrderController", "OrderService"),
        ("OrderController", "DiscountService"),
        ("GreetingController", "GreetingService"),
        ("OrderService", "InMemoryOrderRepository"),
        ("GreetingService", "GreetingDao"),
    }


def test_routes_to_edges(graph):
    conn = _ro(graph)
    n = conn.execute("SELECT COUNT(*) FROM edges WHERE kind='routes_to'").fetchone()[0]
    assert n == 4


def test_static_call_greeting_to_stringutils(graph):
    conn = _ro(graph)
    # GreetingService.greet calls StringUtils.shout and StringUtils.reverse
    dsts = {
        r["name"]
        for r in conn.execute(
            "SELECT d.name name FROM edges e JOIN nodes d ON d.id=e.dst "
            "JOIN nodes s ON s.id=e.src "
            "WHERE e.kind='calls' AND s.name='greet' AND d.kind='method'"
        )
    }
    assert {"shout", "reverse"} <= dsts


def test_layers(graph):
    conn = _ro(graph)
    layer = dict(
        (r["name"], r["layer"])
        for r in conn.execute(
            "SELECT name, layer FROM nodes WHERE kind IN ('class','interface','enum')"
        )
    )
    assert layer["OrderController"] == "controller"
    assert layer["OrderService"] == "service"
    assert layer["InMemoryOrderRepository"] == "repository"
    assert layer["GreetingDao"] == "dao"
    assert layer["Order"] == "model"
    assert layer["StringUtils"] == "util"


# --- MCP tools answer correctly ------------------------------------------------

def test_kg_find_files_for_feature(graph):
    server._DB_FILE = graph
    res = server.kg_find_files_for_feature("order sorting")
    basenames = {os.path.basename(f) for f in res["files"]}
    assert {"OrderController.java", "OrderService.java",
            "InMemoryOrderRepository.java", "Order.java"} <= basenames
    entry_methods = {e["method"] for e in res["entry_methods"]}
    assert "sorted" in entry_methods or "sortedByAmountDescending" in entry_methods


def test_kg_impact_of(graph):
    server._DB_FILE = graph
    res = server.kg_impact_of("OrderService")
    assert "OrderController" in res["impacted"]


def test_kg_endpoints(graph):
    server._DB_FILE = graph
    eps = server.kg_endpoints()
    assert len(eps) == 4


def test_kg_endpoint_downstream(graph):
    server._DB_FILE = graph
    res = server.kg_endpoint("/api/orders/sorted")
    assert res["handler"] == "sorted"
    assert "OrderService" in res["downstream_classes"]


# --- anti-hallucination gate ---------------------------------------------------

def test_enrichment_rejects_unknown_file(graph):
    conn = db.connect(graph)
    db.init_schema(conn)
    with pytest.raises(enrich.EnrichmentRejected):
        enrich.write_feature(conn, "llm:test", "Bogus", "x",
                             ["does/not/Exist.java"])
    conn.close()


def test_enrichment_accepts_known_file(graph):
    conn = db.connect(graph)
    db.init_schema(conn)
    known = db.files(conn)
    a_file = sorted(known)[0]
    enrich.write_feature(conn, "llm:ok", "Real", "x", [a_file])
    n = conn.execute("SELECT COUNT(*) FROM feature_files WHERE feature_id='llm:ok'").fetchone()[0]
    assert n == 1
    conn.close()


def test_enrichment_rejects_unknown_summary_node(graph):
    conn = db.connect(graph)
    db.init_schema(conn)
    with pytest.raises(enrich.EnrichmentRejected):
        enrich.write_summary(conn, "com.example.demo.Nope", "nope")
    conn.close()


# --- sync ----------------------------------------------------------------------

def test_reindex_reflects_change(graph, tmp_path):
    # the fixture is read-only in repo; simulate by copying into tmp and editing
    import shutil
    work = tmp_path / "work"
    shutil.copytree(os.path.join(os.path.dirname(__file__), "fixtures", "demo"), work)
    src = str(work / "src" / "main" / "java")
    db_file = str(tmp_path / "g.db")
    conn = db.connect(db_file)
    db.init_schema(conn)
    build_graph(conn, src)
    before = conn.execute("SELECT COUNT(*) FROM nodes WHERE http_method IS NOT NULL").fetchone()[0]
    conn.close()

    # add a new endpoint to the OrderController
    ctrl = work / "src/main/java/com/example/demo/controller/OrderController.java"
    text = ctrl.read_text().replace(
        "    @GetMapping(\"/sorted\")",
        "    @GetMapping(\"/count\")\n    public int count() { return 0; }\n\n    @GetMapping(\"/sorted\")",
    )
    ctrl.write_text(text)

    conn = db.connect(db_file)
    db.init_schema(conn)
    build_graph(conn, src)
    after = conn.execute("SELECT COUNT(*) FROM nodes WHERE http_method IS NOT NULL").fetchone()[0]
    paths = {r["path"] for r in conn.execute("SELECT path FROM nodes WHERE http_method IS NOT NULL")}
    conn.close()
    assert after == before + 1
    assert "/api/orders/count" in paths
