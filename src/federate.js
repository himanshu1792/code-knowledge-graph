// Federation: merge per-service graphs (frontend + backends) into one and link
// cross-service calls. Each outbound calls_service edge is matched to the called
// service's real endpoint; frontends use target_service '*' (relative URLs) and
// match any backend by method + path -> full-stack request flow.
import * as db from './db.js';

const NODE_COLS = [
  'id', 'kind', 'name', 'file', 'package', 'signature', 'start_line', 'end_line',
  'annotations', 'layer', 'http_method', 'path', 'summary', 'attrs', 'service',
];

const prefix = (svc, id) => `${svc}::${id}`;

function pathMatch(consumed, endpoint) {
  const a = consumed.replace(/^\/|\/$/g, '').split('/');
  const b = endpoint.replace(/^\/|\/$/g, '').split('/');
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] === b[i]) continue;
    if (a[i].startsWith('{') || b[i].startsWith('{') || a[i].startsWith(':') || b[i].startsWith(':')) continue;
    return false;
  }
  return true;
}

function copyService(out, src, name) {
  for (const row of src.prepare(`SELECT ${NODE_COLS.join(', ')} FROM nodes`).all()) {
    const node = { ...row };
    node.id = prefix(name, node.id);
    node.service = node.service || name;
    db.upsertNode(out, node);
  }
  for (const e of src.prepare('SELECT src, dst, kind, attrs FROM edges').all()) {
    db.addEdge(out, prefix(name, e.src), prefix(name, e.dst), e.kind, e.attrs);
  }
  for (const f of src.prepare('SELECT id, name, description FROM features').all()) {
    out.prepare('INSERT OR REPLACE INTO features (id, name, description) VALUES (?,?,?)')
      .run(prefix(name, f.id), f.name, f.description);
  }
  for (const ff of src.prepare('SELECT feature_id, file, entry_node_id FROM feature_files').all()) {
    out.prepare('INSERT OR IGNORE INTO feature_files (feature_id, file, entry_node_id) VALUES (?,?,?)')
      .run(prefix(name, ff.feature_id), ff.file, ff.entry_node_id ? prefix(name, ff.entry_node_id) : null);
  }
}

function resolveCrossCalls(out) {
  const endpoints = out.prepare(
    "SELECT service, http_method, path, id FROM nodes WHERE http_method IS NOT NULL AND kind != 'external_endpoint'",
  ).all();
  let resolved = 0; let unresolved = 0;
  for (const e of out.prepare("SELECT src, dst, attrs FROM edges WHERE kind = 'calls_service'").all()) {
    const a = e.attrs ? JSON.parse(e.attrs) : {};
    const { target_service: target, http_method: method, path = '' } = a;
    let handler = null;
    for (const ep of endpoints) {
      const svcOk = target === '*' || !target || ep.service === target;
      const methodOk = ep.http_method === method || ep.http_method === 'ANY';
      if (svcOk && methodOk && pathMatch(path, ep.path || '')) { handler = ep.id; break; }
    }
    if (handler) {
      db.addEdge(out, e.src, handler, 'calls_remote', JSON.stringify({ ...a, resolved: true }));
      const extRow = out.prepare('SELECT attrs FROM nodes WHERE id = ?').get(e.dst);
      const ext = extRow && extRow.attrs ? JSON.parse(extRow.attrs) : {};
      ext.resolved = true; ext.resolved_to = handler;
      db.setNodeAttrs(out, e.dst, JSON.stringify(ext));
      resolved += 1;
    } else {
      unresolved += 1;
    }
  }
  return { resolved, unresolved };
}

export function federate(outputDb, services) {
  const out = db.connect(outputDb);
  db.initSchema(out);
  db.reset(out);
  for (const { name, dbPath } of services) {
    const src = db.connectRO(dbPath);
    try { copyService(out, src, name); } finally { src.close(); }
  }
  const { resolved, unresolved } = resolveCrossCalls(out);
  db.setMeta(out, 'federated', '1');
  db.setMeta(out, 'services', JSON.stringify(services.map((s) => s.name)));
  out.close();
  return { services: services.map((s) => s.name), links_resolved: resolved, links_unresolved: unresolved };
}
