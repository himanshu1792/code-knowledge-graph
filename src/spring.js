// Spring-awareness pass: endpoints, DI (injects), layers, deterministic features.
import * as db from './db.js';
import { methodNodeId } from './extractJava.js';

export const MAPPING_METHOD = {
  GetMapping: 'GET', PostMapping: 'POST', PutMapping: 'PUT',
  DeleteMapping: 'DELETE', PatchMapping: 'PATCH',
};
const CONTROLLER_ANNS = ['RestController', 'Controller'];

export function pathFromArgs(args) {
  if (!args) return '';
  let m = args.match(/(?:value|path)\s*=\s*"([^"]*)"/);
  if (m) return m[1];
  m = args.match(/"([^"]*)"/);
  return m ? m[1] : '';
}

export function joinPath(prefix, path) {
  const a = prefix.replace(/^\/|\/$/g, '') ? `/${prefix.replace(/^\/|\/$/g, '')}` : '';
  const b = path.replace(/^\/|\/$/g, '') ? `/${path.replace(/^\/|\/$/g, '')}` : '';
  return (a + b) || '/';
}

export function classifyLayer(ci) {
  if (ci.hasAnnotation(...CONTROLLER_ANNS)) return 'controller';
  if (ci.hasAnnotation('Service')) return 'service';
  if (ci.hasAnnotation('Repository')) return 'repository';
  if (ci.hasAnnotation('Configuration')) return 'config';
  if (ci.hasAnnotation('SpringBootApplication')) return 'app';
  if (ci.hasAnnotation('Component')) return 'component';
  const pkg = ci.package ? ci.package.split('.').pop() : '';
  if (pkg === 'dao') return 'dao';
  if (['model', 'entity', 'domain', 'dto'].includes(pkg)) return 'model';
  if (['util', 'utils', 'helper', 'helpers'].includes(pkg)) return 'util';
  if (['repository', 'repo'].includes(pkg)) return 'repository';
  if (pkg === 'config') return 'config';
  return null;
}

export function apply(database, classes, symbols) {
  for (const ci of classes) {
    const layer = classifyLayer(ci);
    if (layer) database.prepare('UPDATE nodes SET layer = ? WHERE id = ?').run(layer, ci.id);
    applyEndpoints(database, ci);
    applyDI(database, ci, symbols);
  }
}

function applyEndpoints(database, ci) {
  if (!ci.hasAnnotation(...CONTROLLER_ANNS)) return;
  const classRm = ci.annotation('RequestMapping');
  const prefix = classRm ? pathFromArgs(classRm.argsText) : '';
  for (const m of ci.methods) {
    let httpMethod = null; let path = null;
    for (const ann of m.annotations) {
      if (MAPPING_METHOD[ann.name]) { httpMethod = MAPPING_METHOD[ann.name]; path = pathFromArgs(ann.argsText); break; }
      if (ann.name === 'RequestMapping') {
        const mm = ann.argsText.match(/RequestMethod\.(\w+)/);
        httpMethod = mm ? mm[1] : 'GET'; path = pathFromArgs(ann.argsText); break;
      }
    }
    if (httpMethod === null) continue;
    const full = joinPath(prefix, path || '');
    const mid = methodNodeId(ci.id, m);
    database.prepare('UPDATE nodes SET http_method = ?, path = ? WHERE id = ?').run(httpMethod, full, mid);
    db.addEdge(database, ci.id, mid, 'routes_to');
  }
}

function applyDI(database, ci, symbols) {
  const targets = new Set();
  for (const f of ci.fields) {
    if (f.annotations.some((a) => a.name === 'Autowired')) {
      const t = symbols.resolve(f.typeSimple, ci); if (t) targets.add(t);
    }
  }
  const ctors = ci.methods.filter((m) => m.isConstructor);
  let chosen = null;
  if (ctors.length === 1) chosen = ctors[0];
  else chosen = ctors.find((c) => c.annotations.some((a) => a.name === 'Autowired')) || null;
  if (chosen) for (const [, pt] of chosen.params) { const t = symbols.resolve(pt, ci); if (t) targets.add(t); }
  for (const t of targets) if (t !== ci.id) db.addEdge(database, ci.id, t, 'injects');
}

export function buildFallbackFeatures(database) {
  database.exec('DELETE FROM feature_files');
  database.exec("DELETE FROM features WHERE id LIKE 'auto:%'");
  const entryLayers = ['controller', 'component']; // backend controllers + frontend root components
  const roots = database.prepare(
    "SELECT id, name, file FROM nodes WHERE layer IN ('controller') AND kind != 'method'",
  ).all();
  const edges = database.prepare(
    "SELECT src, dst FROM edges WHERE kind IN ('injects','calls','routes_to','persists','calls_remote','renders')",
  ).all();
  const adj = new Map();
  for (const e of edges) { if (!adj.has(e.src)) adj.set(e.src, []); adj.get(e.src).push(e.dst); }
  const nodeFile = new Map(database.prepare('SELECT id, file FROM nodes').all().map((r) => [r.id, r.file]));
  const owner = (id) => id.split('#')[0];

  for (const root of roots) {
    const fid = `auto:${root.id}`;
    const name = root.name.replace('Controller', '') || root.name;
    database.prepare('INSERT OR REPLACE INTO features (id, name, description) VALUES (?,?,?)')
      .run(fid, name, `Capabilities exposed by ${root.name}`);
    const seen = new Set(); const stack = [root.id];
    while (stack.length) {
      const cur = stack.pop();
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const nxt of adj.get(cur) || []) {
        if (!seen.has(nxt)) stack.push(nxt);
        const oc = owner(nxt);
        if (!seen.has(oc) && nodeFile.has(oc)) stack.push(oc);
      }
    }
    const filesAdded = new Set();
    for (const nid of seen) {
      const f = nodeFile.get(nid) || nodeFile.get(owner(nid));
      if (f && !filesAdded.has(f)) {
        filesAdded.add(f);
        database.prepare('INSERT OR IGNORE INTO feature_files (feature_id, file, entry_node_id) VALUES (?,?,?)')
          .run(fid, f, root.id);
      }
    }
  }
}
