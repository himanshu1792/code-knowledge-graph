// React / TSX extractor. Models the frontend so it can be federated with backends:
//   * components (function/arrow/class), module nodes
//   * uses_hook edges (useState/useEffect/custom use* hooks)
//   * renders edges (a component renders another component via JSX)
//   * calls_service edges: fetch('/api/..') / axios.get('/api/..') -> external_endpoint,
//     so federation links the frontend call to the backend @GetMapping handler.
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tsxParser, line, endLine } from './parsers.js';
import * as db from './db.js';

const EXTS = ['.jsx', '.tsx', '.js', '.ts'];
const isComp = (name) => !!name && /^[A-Z]/.test(name);

export function discoverReactFiles(root) {
  const out = [];
  const skip = new Set(['node_modules', 'dist', 'build', '.next', '.git', 'coverage', '.code-kg']);
  const walk = (dir) => {
    let entries; try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (!skip.has(e.name)) walk(p); }
      else if (EXTS.some((x) => e.name.endsWith(x)) && !e.name.endsWith('.d.ts')) out.push(p);
    }
  };
  walk(root);
  return out.sort();
}

const strVal = (node) => {
  if (!node) return null;
  let t = node.text;
  if (t.length >= 2 && '"\'`'.includes(t[0])) t = t.slice(1, -1);
  return t;
};

function componentName(node) {
  // returns a component name if this node defines one, else null
  if (node.type === 'function_declaration') {
    const n = node.childForFieldName('name');
    if (n && isComp(n.text)) return n.text;
  }
  if (node.type === 'class_declaration') {
    const n = node.childForFieldName('name');
    if (n && isComp(n.text)) return n.text;
  }
  if (node.type === 'variable_declarator') {
    const n = node.childForFieldName('name');
    const v = node.childForFieldName('value');
    if (n && isComp(n.text) && v && ['arrow_function', 'function_expression', 'function'].includes(v.type)) return n.text;
  }
  return null;
}

function parseUrl(u) {
  if (!u) return null;
  if (u.startsWith('http://') || u.startsWith('https://')) {
    try { const p = new URL(u); return { service: p.hostname, path: p.pathname }; } catch { return null; }
  }
  if (u.startsWith('/')) return { service: '*', path: u.split('?')[0] };
  return null;
}

function optionsMethod(argNode) {
  if (!argNode || argNode.type !== 'object') return null;
  for (const pair of argNode.children) {
    if (pair.type === 'pair') {
      const k = pair.childForFieldName('key');
      const v = pair.childForFieldName('value');
      if (k && k.text === 'method' && v) return (strVal(v) || '').toUpperCase() || null;
    }
  }
  return null;
}

// Detect an HTTP client call -> { method, url } or null
function httpCall(node) {
  if (node.type !== 'call_expression') return null;
  const fn = node.childForFieldName('function');
  const args = node.childForFieldName('arguments');
  if (!fn || !args) return null;
  const argList = args.children.filter((c) => c.type !== '(' && c.type !== ')' && c.type !== ',');

  // fetch(url, opts)
  if (fn.type === 'identifier' && fn.text === 'fetch') {
    const url = strVal(argList[0]);
    return urlCall('FETCH', url, optionsMethod(argList[1]) || 'GET');
  }
  // axios(url, opts)
  if (fn.type === 'identifier' && fn.text === 'axios') {
    return urlCall('AXIOS', strVal(argList[0]), optionsMethod(argList[1]) || 'GET');
  }
  // axios.get/post/put/delete/patch(url)
  if (fn.type === 'member_expression') {
    const obj = fn.childForFieldName('object');
    const prop = fn.childForFieldName('property');
    if (obj && prop && obj.text === 'axios' && ['get', 'post', 'put', 'delete', 'patch'].includes(prop.text)) {
      return urlCall('AXIOS', strVal(argList[0]), prop.text.toUpperCase());
    }
  }
  return null;
}
function urlCall(_via, url, method) {
  const parsed = parseUrl(url);
  if (!parsed) return null;
  return { service: parsed.service, method, path: parsed.path };
}

function hookName(node) {
  if (node.type !== 'call_expression') return null;
  const fn = node.childForFieldName('function');
  if (fn && fn.type === 'identifier' && /^use[A-Z]/.test(fn.text)) return fn.text;
  return null;
}

export function parseReactRepo(root) {
  const files = [];
  const compByName = new Map(); // name -> [ids]
  for (const abs of discoverReactFiles(root)) {
    const rel = relative(root, abs);
    const src = readFileSync(abs, 'utf8');
    const tree = tsxParser().parse(src);
    files.push({ rel, tree });
    const collect = (node) => {
      const name = componentName(node);
      if (name) {
        const id = `${rel}#${name}`;
        if (!compByName.has(name)) compByName.set(name, []);
        compByName.get(name).push(id);
      }
      for (const ch of node.children) collect(ch);
    };
    collect(tree.rootNode);
  }
  return { files, compByName };
}

export function extractReact(database, root) {
  const { files, compByName } = parseReactRepo(root);
  const resolveComp = (name) => {
    const ids = compByName.get(name);
    return ids && ids.length === 1 ? ids[0] : null;
  };

  for (const { rel, tree } of files) {
    const moduleId = `module::${rel}`;
    db.upsertNode(database, { id: moduleId, kind: 'module', name: rel, file: rel, layer: 'module' });

    const walk = (node, currentComp) => {
      let comp = currentComp;
      const name = componentName(node);
      if (name) {
        comp = `${rel}#${name}`;
        db.upsertNode(database, {
          id: comp, kind: 'component', name, file: rel,
          start_line: line(node), end_line: endLine(node), layer: 'component',
        });
      }
      const src = comp || moduleId;

      // JSX render relationships
      if (node.type === 'jsx_opening_element' || node.type === 'jsx_self_closing_element') {
        const nm = node.childForFieldName('name');
        if (nm && isComp(nm.text)) {
          const tgt = resolveComp(nm.text);
          if (tgt && comp && tgt !== comp) db.addEdge(database, comp, tgt, 'renders');
        }
      }
      // hooks
      const hn = hookName(node);
      if (hn) {
        const hid = `hook::${hn}`;
        db.upsertNode(database, { id: hid, kind: 'hook', name: hn, layer: 'hook' });
        db.addEdge(database, src, hid, 'uses_hook');
      }
      // http calls -> external endpoint
      const call = httpCall(node);
      if (call) {
        const extId = `external::${call.service}::${call.method} ${call.path}`;
        db.upsertNode(database, {
          id: extId, kind: 'external_endpoint', name: `${call.method} ${call.path}`,
          http_method: call.method, path: call.path, service: call.service,
          attrs: JSON.stringify({ target_service: call.service, http_method: call.method, path: call.path, via: 'frontend', resolved: false }),
        });
        db.addEdge(database, src, extId, 'calls_service',
          JSON.stringify({ target_service: call.service, http_method: call.method, path: call.path, via: 'frontend' }));
      }
      for (const ch of node.children) walk(ch, comp);
    };
    walk(tree.rootNode, null);
  }
}
