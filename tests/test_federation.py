"""Cross-service federation: outbound-call extraction + linking across services."""

import os
import sqlite3

import pytest

from code_kg import db, federate, server
from code_kg.cli import build_graph

MS = os.path.join(os.path.dirname(__file__), "fixtures", "ms")
LOGIN_SRC = os.path.join(MS, "login-service", "src", "main", "java")
USER_SRC = os.path.join(MS, "user-service", "src", "main", "java")


def _index(tmp_path, name, src):
    db_file = str(tmp_path / f"{name}.db")
    conn = db.connect(db_file)
    db.init_schema(conn)
    build_graph(conn, src, service=name)
    conn.close()
    return db_file


@pytest.fixture()
def merged(tmp_path):
    login_db = _index(tmp_path, "login-service", LOGIN_SRC)
    # index user-service FIRST conceptually too — order must not matter
    user_db = _index(tmp_path, "user-service", USER_SRC)
    out = str(tmp_path / "merged.db")
    report = federate.federate(out, [("user-service", user_db), ("login-service", login_db)])
    return out, report


def _ro(db_file):
    conn = sqlite3.connect(db_file)
    conn.row_factory = sqlite3.Row
    return conn


# --- outbound extraction (single service) --------------------------------------

def test_outbound_calls_recorded(tmp_path):
    user_db = _index(tmp_path, "user-service", USER_SRC)
    conn = _ro(user_db)
    ext = {
        (r["http_method"], r["path"], r["service"])
        for r in conn.execute(
            "SELECT http_method, path, service FROM nodes WHERE kind='external_endpoint'"
        )
    }
    # Feign POST /auth/login and RestTemplate GET /auth/validate, both to login-service
    assert ("POST", "/auth/login", "login-service") in ext
    assert ("GET", "/auth/validate", "login-service") in ext


def test_nodes_tagged_with_service(tmp_path):
    user_db = _index(tmp_path, "user-service", USER_SRC)
    conn = _ro(user_db)
    svc = conn.execute("SELECT DISTINCT service FROM nodes WHERE kind='class'").fetchone()
    assert svc["service"] == "user-service"


# --- federation links ----------------------------------------------------------

def test_cross_service_links_resolved(merged):
    out, report = merged
    assert report["links_resolved"] >= 2          # feign login + resttemplate validate
    assert report["links_unresolved"] == 0
    conn = _ro(out)
    links = {
        (r["s"], r["d"])
        for r in conn.execute(
            "SELECT s.name s, d.name d FROM edges e "
            "JOIN nodes s ON s.id=e.src JOIN nodes d ON d.id=e.dst "
            "WHERE e.kind='calls_remote'"
        )
    }
    # user-service LoginClient.authenticate -> login-service AuthController.login
    assert ("authenticate", "login") in links
    # user-service UserService.register -> login-service AuthController.validate
    assert ("register", "validate") in links


def test_order_independent(tmp_path):
    # federate the SAME two services in the opposite order -> same resolved count
    login_db = _index(tmp_path, "login-service", LOGIN_SRC)
    user_db = _index(tmp_path, "user-service", USER_SRC)
    out_a = str(tmp_path / "a.db")
    out_b = str(tmp_path / "b.db")
    ra = federate.federate(out_a, [("login-service", login_db), ("user-service", user_db)])
    rb = federate.federate(out_b, [("user-service", user_db), ("login-service", login_db)])
    assert ra["links_resolved"] == rb["links_resolved"] >= 2


# --- federated MCP tools -------------------------------------------------------

def test_kg_service_map(merged):
    out, _ = merged
    server._DB_FILE = out
    sm = server.kg_service_map()
    assert set(sm["services"]) == {"user-service", "login-service"}
    dep = next(d for d in sm["dependencies"]
               if d["from"] == "user-service" and d["to"] == "login-service")
    assert dep["resolved"] >= 2
    assert dep["unresolved"] == 0


def test_kg_request_flow_crosses_services(merged):
    out, _ = merged
    server._DB_FILE = out
    flow = server.kg_request_flow("/users/register", "POST")
    assert flow["entry"]["service"] == "user-service"
    assert "login-service" in flow["services_touched"]
    assert any(h["via"] == "calls_remote" for h in flow["cross_service_hops"])


def test_impact_crosses_services(merged):
    out, _ = merged
    server._DB_FILE = out
    # changing login-service AuthController should impact the user-service caller
    res = server.kg_impact_of("login-service::com.example.login.controller.AuthController")
    assert any("user-service" in n or n in ("UserService", "LoginClient", "UserController")
               for n in res["impacted"]) or res["impacted"]
