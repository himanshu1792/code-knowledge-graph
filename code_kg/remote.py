"""Cross-service (outbound call) extraction — the basis for federation.

Detects calls a service makes to *other* services and records them so a later
``federate`` step can link them to the called service's endpoints:

  * OpenFeign  — ``@FeignClient(name="login-service")`` interfaces; each mapping
                 method becomes an outbound endpoint (method + class-prefix path).
  * RestTemplate — ``getForObject``/``postForObject``/… calls whose URL literal is
                 ``http://<service>/<path>`` (Spring service-discovery style).

Each outbound call is stored as a synthetic ``external_endpoint`` node plus a
``calls_service`` edge from the caller, carrying ``{target_service, http_method,
path, via}`` in ``attrs``. ``federate`` resolves these to real endpoints.
"""

from __future__ import annotations

import json
import re
from typing import Optional
from urllib.parse import urlparse

from .extract import ClassInfo, Symbols
from .spring import MAPPING_METHOD, _join, _path_from_args

# RestTemplate method name -> HTTP method
REST_TEMPLATE_HTTP = {
    "getForObject": "GET", "getForEntity": "GET",
    "postForObject": "POST", "postForEntity": "POST", "postForLocation": "POST",
    "put": "PUT", "delete": "DELETE", "patchForObject": "PATCH",
}
HTTP_CLIENT_TYPES = {"RestTemplate", "TestRestTemplate"}


def _feign_service(ci: ClassInfo) -> Optional[str]:
    ann = ci.annotation("FeignClient")
    if ann is None:
        return None
    args = ann.args_text or ""
    name = _str_arg(args, "name") or _str_arg(args, "value") or _first_literal(args)
    return name


def _str_arg(args: str, key: str) -> Optional[str]:
    m = re.search(rf'{key}\s*=\s*"([^"]*)"', args)
    return m.group(1) if m else None


def _first_literal(args: str) -> Optional[str]:
    m = re.search(r'"([^"]+)"', args)
    return m.group(1) if m else None


def _ext_node_id(service: str, method: str, path: str) -> str:
    return f"external::{service}::{method} {path}"


def _norm(path: str) -> str:
    return "/" + path.strip("/") if path.strip("/") else "/"


def apply(conn, classes: list[ClassInfo], symbols: Symbols) -> None:
    from . import db

    for ci in classes:
        feign_service = _feign_service(ci)
        if feign_service:
            _apply_feign(conn, ci, feign_service)
        _apply_resttemplate(conn, ci, symbols)
    conn.commit()


def _record_outbound(conn, src_node_id: str, service: str, method: str,
                     path: str, via: str) -> None:
    from . import db

    ext_id = _ext_node_id(service, method, _norm(path))
    db.upsert_node(conn, {
        "id": ext_id,
        "kind": "external_endpoint",
        "name": f"{method} {_norm(path)}",
        "file": None,
        "package": None,
        "http_method": method,
        "path": _norm(path),
        "service": service,
        "attrs": json.dumps({"target_service": service, "http_method": method,
                             "path": _norm(path), "via": via, "resolved": False}),
    })
    db.add_edge(conn, src_node_id, ext_id, "calls_service",
                json.dumps({"target_service": service, "http_method": method,
                            "path": _norm(path), "via": via}))


def _apply_feign(conn, ci: ClassInfo, service: str) -> None:
    class_rm = ci.annotation("RequestMapping")
    prefix = _path_from_args(class_rm.args_text) if class_rm else ""
    for mi in ci.methods:
        for ann in mi.annotations:
            if ann.name in MAPPING_METHOD:
                method = MAPPING_METHOD[ann.name]
                path = _join(prefix, _path_from_args(ann.args_text) or "")
                _record_outbound(conn, mi.node_id(ci.id), service, method, path, "feign")
                break
            if ann.name == "RequestMapping":
                m = re.search(r"RequestMethod\.(\w+)", ann.args_text)
                method = m.group(1) if m else "GET"
                path = _join(prefix, _path_from_args(ann.args_text) or "")
                _record_outbound(conn, mi.node_id(ci.id), service, method, path, "feign")
                break


def _apply_resttemplate(conn, ci: ClassInfo, symbols: Symbols) -> None:
    for mi in ci.methods:
        # variable -> type environment (fields + params + locals)
        env: dict[str, str] = {}
        for fld in ci.fields:
            if fld.type_simple:
                env[fld.name] = fld.type_simple
        for pname, ptype in mi.params:
            if ptype:
                env[pname] = ptype
        env.update(mi.locals)

        for inv in mi.invocations:
            if inv.method not in REST_TEMPLATE_HTTP:
                continue
            rtype = env.get(inv.receiver) if inv.receiver else None
            if rtype not in HTTP_CLIENT_TYPES:
                continue
            url = next((a for a in inv.str_args if a.startswith(("http://", "https://"))), None)
            if not url:
                continue
            parsed = urlparse(url)
            service = parsed.hostname or ""
            if not service or parsed.path in ("", "/"):
                continue
            _record_outbound(conn, mi.node_id(ci.id), service,
                             REST_TEMPLATE_HTTP[inv.method], parsed.path, "resttemplate")
