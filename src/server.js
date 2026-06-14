// MCP server exposing the knowledge graph as kg_* tools. The query functions are
// also exported directly (used by tests); serve() wires them onto an MCP server.
import { resolve, basename } from 'node:path';
import * as db from './db.js';

let DB_FILE = null;
export function setDb(p) { DB_FILE = resolve(p); }
const conn = () => db.connectRO(DB_FILE);
const REL_KINDS = ['one_to_many', 'many_to_one', 'one_to_one', 'many_to_many'];

const ownerClass = (id) => id.split('#')[0];
const loads = (s) => { try { return s ? JSON.parse(s) : {}; } catch { return {}; } };

function nodeBrief(c, id) {
  const r = c.prepare(
    'SELECT id, kind, name, file, start_line, layer, http_method, path, summary, service FROM nodes WHERE id = ?',
  ).get(id);
  if (!r) return { id };
  const d = { id: r.id, kind: r.kind, name: r.name, file: r.file, line: r.start_line };
  for (const k of ['service', 'layer', 'http_method', 'path', 'summary']) if (r[k]) d[k] = r[k];
  return d;
}

function resolveSym(c, symbol) {
  let r = c.prepare('SELECT id FROM nodes WHERE id = ?').get(symbol);
  if (r) return [r.id];
  if (symbol.endsWith('.java') || symbol.endsWith('.tsx') || symbol.endsWith('.jsx') || symbol.endsWith('.ts')) {
    const rows = c.prepare(
      "SELECT id FROM nodes WHERE (file = ? OR file LIKE ?) AND kind IN ('class','interface','enum','component','module')",
    ).all(symbol, `%${basename(symbol)}`);
    if (rows.length) return rows.map((x) => x.id);
  }
  let rows = c.prepare("SELECT id FROM nodes WHERE name = ? AND kind IN ('class','interface','enum','component')").all(symbol);
  if (rows.length) return rows.map((x) => x.id);
  rows = c.prepare("SELECT id FROM nodes WHERE name = ? AND kind = 'method'").all(symbol);
  return rows.map((x) => x.id);
}

function expandMembers(c, ids) {
  const out = new Set(ids);
  for (const id of ids) {
    for (const r of c.prepare('SELECT id FROM nodes WHERE id LIKE ? OR id LIKE ?').all(`${id}#%`, `${id}.%`)) out.add(r.id);
  }
  return [...out];
}

function reachable(c, start, kinds, forward) {
  const fromCol = forward ? 'src' : 'dst';
  const toCol = forward ? 'dst' : 'src';
  const ph = kinds.map(() => '?').join(',');
  const seen = new Set(start); const stack = [...start];
  while (stack.length) {
    const cur = stack.pop();
    for (const r of c.prepare(`SELECT ${toCol} AS nxt FROM edges WHERE ${fromCol} = ? AND kind IN (${ph})`).all(cur, ...kinds)) {
      if (!seen.has(r.nxt)) { seen.add(r.nxt); stack.push(r.nxt); }
      const oc = ownerClass(r.nxt);
      if (oc !== r.nxt && !seen.has(oc)) { seen.add(oc); stack.push(oc); }
    }
  }
  return seen;
}

function searchTerms(query) {
  const tokens = query.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 2);
  const terms = new Set();
  for (const t of tokens) { terms.add(`%${t}%`); if (t.length > 4) terms.add(`%${t.slice(0, 4)}%`); }
  return [...terms];
}

// --- tools ---
export function kgArchitecture() {
  const c = conn();
  const one = (sql) => c.prepare(sql).get().n;
  const counts = {
    classes: one("SELECT COUNT(*) n FROM nodes WHERE kind IN ('class','interface','enum')"),
    components: one("SELECT COUNT(*) n FROM nodes WHERE kind='component'"),
    endpoints: one('SELECT COUNT(*) n FROM nodes WHERE http_method IS NOT NULL'),
    injects: one("SELECT COUNT(*) n FROM edges WHERE kind='injects'"),
  };
  const layers = {};
  for (const r of c.prepare("SELECT layer, name FROM nodes WHERE layer IS NOT NULL AND kind IN ('class','interface','enum','component') ORDER BY layer, name").all()) {
    (layers[r.layer] ||= []).push(r.name);
  }
  const endpoints = c.prepare("SELECT http_method, path, name FROM nodes WHERE http_method IS NOT NULL AND kind!='external_endpoint' ORDER BY path").all()
    .map((r) => ({ method: r.http_method, path: r.path, handler: r.name }));
  c.close();
  return { counts, layers, endpoints };
}

export function kgEndpoints() {
  const c = conn();
  const r = c.prepare("SELECT id, http_method, path, name, file, service FROM nodes WHERE http_method IS NOT NULL AND kind!='external_endpoint' ORDER BY path").all()
    .map((x) => ({ method: x.http_method, path: x.path, handler: x.name, file: x.file, service: x.service, node_id: x.id }));
  c.close();
  return r;
}

export function kgEndpoint(path) {
  const c = conn();
  let r = c.prepare("SELECT id, http_method, path, name, file FROM nodes WHERE http_method IS NOT NULL AND kind!='external_endpoint' AND path = ?").get(path);
  if (!r) r = c.prepare("SELECT id, http_method, path, name, file FROM nodes WHERE http_method IS NOT NULL AND kind!='external_endpoint' AND path LIKE ?").get(`%${path.replace(/^\/|\/$/g, '')}%`);
  if (!r) { c.close(); return { error: `no endpoint matching ${path}` }; }
  const chain = reachable(c, new Set([r.id]), ['calls', 'calls_remote'], true);
  chain.delete(r.id);
  const downstream = [...new Set([...chain].map(ownerClass))].map((x) => nodeBrief(c, x).name).filter(Boolean);
  c.close();
  return { method: r.http_method, path: r.path, handler: r.name, file: r.file, node_id: r.id, downstream_classes: downstream };
}

export function kgFindFilesForFeature(query) {
  const c = conn();
  const terms = searchTerms(query);
  const files = new Set(); const entries = []; const featureNames = new Set(); const seen = new Set();
  for (const term of terms) {
    for (const r of c.prepare('SELECT id, name FROM features WHERE LOWER(name) LIKE ? OR LOWER(description) LIKE ?').all(term, term)) {
      featureNames.add(r.name);
      for (const ff of c.prepare('SELECT file FROM feature_files WHERE feature_id = ?').all(r.id)) files.add(ff.file);
    }
    for (const r of c.prepare('SELECT id, kind, name, file, http_method, path FROM nodes WHERE LOWER(name) LIKE ? OR LOWER(path) LIKE ? OR LOWER(summary) LIKE ?').all(term, term, term)) {
      if (r.file) files.add(r.file);
      if ((r.kind === 'method' || r.kind === 'component') && !seen.has(r.id)) {
        seen.add(r.id);
        entries.push({ symbol: r.name, file: r.file, endpoint: r.http_method ? r.path : null, node_id: r.id });
      }
    }
  }
  c.close();
  return { query, features: [...featureNames].sort(), files: [...files].sort(), entry_points: entries };
}

export function kgCallers(symbol) {
  const c = conn();
  const ids = expandMembers(c, resolveSym(c, symbol));
  if (!ids.length) { c.close(); return []; }
  const ph = ids.map(() => '?').join(',');
  const rows = c.prepare(`SELECT DISTINCT src FROM edges WHERE kind IN ('calls','calls_remote') AND dst IN (${ph})`).all(...ids);
  const out = rows.map((r) => nodeBrief(c, r.src)); c.close(); return out;
}

export function kgCallees(symbol) {
  const c = conn();
  const ids = expandMembers(c, resolveSym(c, symbol));
  if (!ids.length) { c.close(); return []; }
  const ph = ids.map(() => '?').join(',');
  const rows = c.prepare(`SELECT DISTINCT dst FROM edges WHERE kind IN ('calls','calls_remote') AND src IN (${ph})`).all(...ids);
  const out = rows.map((r) => nodeBrief(c, r.dst)); c.close(); return out;
}

export function kgImpactOf(symbol) {
  const c = conn();
  const base = resolveSym(c, symbol);
  if (!base.length) { c.close(); return { symbol, error: 'symbol not found', impacted: [] }; }
  const start = expandMembers(c, base);
  const reached = reachable(c, new Set(start), ['calls', 'calls_remote', 'injects', 'routes_to', 'persists', 'renders', ...REL_KINDS], false);
  const startSet = new Set(start);
  for (const s of startSet) reached.delete(s);
  const selfClasses = new Set(start.map(ownerClass));
  const impacted = [...new Set([...reached].map(ownerClass))].filter((x) => !selfClasses.has(x))
    .map((x) => nodeBrief(c, x).name).filter(Boolean).sort();
  c.close();
  return { symbol, impacted };
}

export function kgNeighbors(node) {
  const c = conn();
  const ids = resolveSym(c, node);
  if (!ids.length) { c.close(); return { node, error: 'not found' }; }
  const nid = ids[0];
  const outE = c.prepare('SELECT dst, kind FROM edges WHERE src = ?').all(nid).map((r) => ({ kind: r.kind, to: nodeBrief(c, r.dst) }));
  const inE = c.prepare('SELECT src, kind FROM edges WHERE dst = ?').all(nid).map((r) => ({ kind: r.kind, from: nodeBrief(c, r.src) }));
  const brief = nodeBrief(c, nid); c.close();
  return { node: brief, outgoing: outE, incoming: inE };
}

export function kgDescribe(node) {
  const c = conn();
  const ids = resolveSym(c, node);
  if (!ids.length) { c.close(); return { node, error: 'not found' }; }
  const r = c.prepare('SELECT * FROM nodes WHERE id = ?').get(ids[0]);
  const d = { ...r };
  if (['class', 'interface', 'enum', 'component'].includes(r.kind)) {
    d.methods = c.prepare("SELECT name, signature, http_method, path FROM nodes WHERE id LIKE ? AND kind='method' ORDER BY start_line").all(`${r.id}#%`)
      .map((m) => ({ name: m.name, signature: m.signature, endpoint: m.http_method ? `${m.http_method} ${m.path}` : null }));
  }
  c.close();
  return d;
}

export function kgDataModel() {
  const c = conn();
  const entities = c.prepare("SELECT id, name, file, attrs FROM nodes WHERE layer='entity' AND kind IN ('class','interface','enum') ORDER BY name").all()
    .map((r) => { const a = loads(r.attrs); return { entity: r.name, table: a.table, file: r.file, primary_key: (a.columns || []).filter((x) => x.primary_key).map((x) => x.column), column_count: (a.columns || []).length }; });
  const ph = REL_KINDS.map(() => '?').join(',');
  const relationships = c.prepare(`SELECT src, dst, kind, attrs FROM edges WHERE kind IN (${ph})`).all(...REL_KINDS).map((r) => {
    const a = loads(r.attrs);
    const rel = { from: nodeBrief(c, r.src).name, kind: r.kind, to: nodeBrief(c, r.dst).name, owning: a.owning, fetch: a.fetch };
    for (const k of ['mapped_by', 'cascade', 'orphan_removal', 'join_column', 'join_table', 'referenced_column']) if (k in a) rel[k] = a[k];
    return rel;
  });
  const repositories = c.prepare("SELECT src, dst FROM edges WHERE kind='persists'").all()
    .map((r) => ({ repository: nodeBrief(c, r.src).name, manages_entity: nodeBrief(c, r.dst).name }));
  c.close();
  return { entities, relationships, repositories };
}

export function kgEntity(name) {
  const c = conn();
  const ids = resolveSym(c, name).filter((i) => ['class', 'interface', 'enum'].includes(nodeBrief(c, i).kind));
  if (!ids.length) { c.close(); return { entity: name, error: 'not found' }; }
  const nid = ids[0];
  const r = c.prepare('SELECT name, file, attrs FROM nodes WHERE id = ?').get(nid);
  const a = loads(r.attrs);
  const ph = REL_KINDS.map(() => '?').join(',');
  const rels = c.prepare(`SELECT dst, kind, attrs FROM edges WHERE src = ? AND kind IN (${ph})`).all(nid, ...REL_KINDS)
    .map((e) => ({ ...loads(e.attrs), kind: e.kind, to: nodeBrief(c, e.dst).name }));
  const inbound = c.prepare(`SELECT src, kind, attrs FROM edges WHERE dst = ? AND kind IN (${ph})`).all(nid, ...REL_KINDS)
    .map((e) => ({ kind: e.kind, from: nodeBrief(c, e.src).name, ...loads(e.attrs) }));
  const managedBy = c.prepare("SELECT src FROM edges WHERE dst = ? AND kind='persists'").all(nid).map((e) => nodeBrief(c, e.src).name);
  c.close();
  return { entity: r.name, file: r.file, table: a.table, columns: a.columns || [], relationships: rels, referenced_by: inbound, repositories: managedBy };
}

export function kgServiceMap() {
  const c = conn();
  const services = [...new Set(c.prepare("SELECT DISTINCT service FROM nodes WHERE service IS NOT NULL AND service != '*' AND kind != 'external_endpoint'").all().map((r) => r.service))].sort();
  const deps = new Map();
  const add = (frm, to, ep, resolved) => {
    const key = `${frm}->${to}`;
    const e = deps.get(key) || { from: frm, to, calls: [], resolved: 0, unresolved: 0 };
    e.calls.push(ep); e[resolved ? 'resolved' : 'unresolved'] += 1; deps.set(key, e);
  };
  for (const r of c.prepare("SELECT src, dst, attrs FROM edges WHERE kind='calls_remote'").all()) {
    const a = loads(r.attrs);
    add(nodeBrief(c, r.src).service, nodeBrief(c, r.dst).service || a.target_service, `${a.http_method} ${a.path}`, true);
  }
  for (const r of c.prepare("SELECT e.src src, e.attrs a FROM edges e JOIN nodes n ON n.id=e.dst WHERE e.kind='calls_service' AND n.kind='external_endpoint' AND (n.attrs IS NULL OR n.attrs NOT LIKE '%\"resolved\":true%')").all()) {
    const a = loads(r.a);
    add(nodeBrief(c, r.src).service, a.target_service, `${a.http_method} ${a.path}`, false);
  }
  c.close();
  return { services, dependencies: [...deps.values()] };
}

export function kgRequestFlow(path, method = '') {
  const c = conn();
  let rows;
  if (method) rows = c.prepare("SELECT id, http_method, path, name, service FROM nodes WHERE http_method IS NOT NULL AND kind!='external_endpoint' AND path = ? AND http_method = ?").all(path, method.toUpperCase());
  else rows = c.prepare("SELECT id, http_method, path, name, service FROM nodes WHERE http_method IS NOT NULL AND kind!='external_endpoint' AND path = ?").all(path);
  if (!rows.length) rows = c.prepare("SELECT id, http_method, path, name, service FROM nodes WHERE http_method IS NOT NULL AND kind!='external_endpoint' AND path LIKE ?").all(`%${path.replace(/^\/|\/$/g, '')}%`);
  if (!rows.length) { c.close(); return { path, error: 'no endpoint matched' }; }
  const start = rows[0];
  const reached = reachable(c, new Set([start.id]), ['routes_to', 'calls', 'calls_remote', 'renders'], true);
  const arr = [...reached];
  const ph = arr.map(() => '?').join(',');
  const hops = c.prepare(`SELECT src, dst, kind FROM edges WHERE kind='calls_remote' AND src IN (${ph})`).all(...arr)
    .map((e) => ({ from: nodeBrief(c, e.src), to: nodeBrief(c, e.dst), via: e.kind }));
  const servicesTouched = [...new Set(arr.map((n) => nodeBrief(c, n).service).filter((s) => s && s !== '*'))].sort();
  const reachableBriefs = arr.sort().map((n) => nodeBrief(c, n));
  c.close();
  return {
    entry: { method: start.http_method, path: start.path, handler: start.name, service: start.service },
    services_touched: servicesTouched, cross_service_hops: hops, reachable: reachableBriefs,
  };
}

// --- MCP wiring ---
export async function serve(dbFile) {
  setDb(dbFile);
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const { z } = await import('zod');
  const server = new McpServer({ name: 'code-kg', version: '0.2.0' });
  const wrap = (fn) => async (args) => ({ content: [{ type: 'text', text: JSON.stringify(fn(args), null, 2) }] });

  const reg = (name, desc, shape, fn) => server.tool(name, desc, shape, fn);
  reg('kg_architecture', 'Layered architecture overview (counts, layers, endpoints).', {}, wrap(() => kgArchitecture()));
  reg('kg_endpoints', 'List all HTTP endpoints extracted from code.', {}, wrap(() => kgEndpoints()));
  reg('kg_endpoint', 'Describe one endpoint and its downstream call chain.', { path: z.string() }, wrap(({ path }) => kgEndpoint(path)));
  reg('kg_find_files_for_feature', 'Files + entry points implementing a feature/capability.', { query: z.string() }, wrap(({ query }) => kgFindFilesForFeature(query)));
  reg('kg_callers', 'Who calls this class/method/component.', { symbol: z.string() }, wrap(({ symbol }) => kgCallers(symbol)));
  reg('kg_callees', 'What this class/method/component calls.', { symbol: z.string() }, wrap(({ symbol }) => kgCallees(symbol)));
  reg('kg_impact_of', 'What is affected if this symbol/file changes (reverse reachability, cross-service).', { symbol: z.string() }, wrap(({ symbol }) => kgImpactOf(symbol)));
  reg('kg_neighbors', 'Direct neighbors of a node (in + out edges).', { node: z.string() }, wrap(({ node }) => kgNeighbors(node)));
  reg('kg_describe', 'Full detail of a node (signature, layer, annotations, summary, members).', { node: z.string() }, wrap(({ node }) => kgDescribe(node)));
  reg('kg_data_model', 'JPA/Hibernate entities, tables, relationships, repositories.', {}, wrap(() => kgDataModel()));
  reg('kg_entity', 'Full mapping of one JPA entity.', { name: z.string() }, wrap(({ name }) => kgEntity(name)));
  reg('kg_service_map', 'Service-to-service dependency map (frontend + backends).', {}, wrap(() => kgServiceMap()));
  reg('kg_request_flow', 'Trace a request through the call chain, across services.', { path: z.string(), method: z.string().optional() }, wrap(({ path, method }) => kgRequestFlow(path, method || '')));

  await server.connect(new StdioServerTransport());
}
