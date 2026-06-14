// React / TSX extractor. Models the frontend so it can be federated with backends.
//   * components (function/arrow/class), module nodes
//   * uses_hook edges (useState/useEffect/custom use* hooks)
//   * renders edges (a component renders another component via JSX)
//   * passes_prop edges (parent -> child, with the prop names) + component prop lists
//   * context: createContext nodes, uses_context / provides_context edges
//   * routes: react-router <Route path element/> and Next.js file-based pages/app
//   * calls_service edges: fetch/axios('/api/..') -> external_endpoint (full-stack)
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
  // HTTP-method names (GET/POST/...) are Next.js route handlers, not components.
  const ok = (n) => n && isComp(n.text) && !HTTP_METHODS.has(n.text);
  if (node.type === 'function_declaration' || node.type === 'class_declaration') {
    const n = node.childForFieldName('name');
    if (ok(n)) return n.text;
  }
  if (node.type === 'variable_declarator') {
    const n = node.childForFieldName('name');
    const v = node.childForFieldName('value');
    if (ok(n) && v && ['arrow_function', 'function_expression', 'function'].includes(v.type)) return n.text;
  }
  return null;
}

function contextNameOf(node) {
  // const X = createContext(...) / React.createContext(...)
  if (node.type !== 'variable_declarator') return null;
  const n = node.childForFieldName('name');
  const v = node.childForFieldName('value');
  if (!n || !v || v.type !== 'call_expression') return null;
  const fn = v.childForFieldName('function');
  if (!fn) return null;
  if (fn.type === 'identifier' && fn.text === 'createContext') return n.text;
  if (fn.type === 'member_expression' && fn.childForFieldName('property')?.text === 'createContext') return n.text;
  return null;
}

function paramsNode(node) {
  if (node.type === 'function_declaration' || node.type === 'class_declaration') return node.childForFieldName('parameters');
  if (node.type === 'variable_declarator') { const v = node.childForFieldName('value'); return v ? v.childForFieldName('parameters') : null; }
  return null;
}
function propNames(node) {
  const pn = paramsNode(node);
  if (!pn) return [];
  const first = pn.namedChildren?.[0];
  if (!first) return [];
  const pattern = first.childForFieldName ? (first.childForFieldName('pattern') || first) : first;
  const target = pattern.type === 'object_pattern' ? pattern : pattern.descendantsOfType?.('object_pattern')?.[0];
  if (!target) return pattern.type === 'identifier' ? [`${pattern.text}(props)`] : [];
  const names = [];
  for (const ch of target.children) {
    if (ch.type === 'shorthand_property_identifier_pattern') names.push(ch.text);
    else if (ch.type === 'pair_pattern') { const k = ch.childForFieldName('key'); if (k) names.push(k.text); }
    else if (ch.type === 'rest_pattern') names.push('...rest');
  }
  return names;
}

function getJsxName(node) {
  if (!node) return null;
  const n = node.childForFieldName('name');
  if (n) return n.text;
  const c = node.children.find((x) => ['identifier', 'member_expression', 'nested_identifier', 'jsx_namespace_name', 'property_identifier'].includes(x.type));
  return c ? c.text : null;
}
function jsxAttrs(node) {
  const out = [];
  for (const ch of node.children) {
    if (ch.type === 'jsx_attribute') {
      const nameNode = ch.children.find((x) => x.type === 'property_identifier');
      const valNode = ch.children.find((x) => ['string', 'jsx_expression'].includes(x.type));
      out.push({ name: nameNode ? nameNode.text : null, valNode });
    }
  }
  return out;
}
function compFromValue(valNode) {
  if (!valNode) return null;
  if (valNode.type === 'string') return null;
  if (valNode.type === 'jsx_expression') {
    const inner = valNode.children.find((x) => ['jsx_element', 'jsx_self_closing_element', 'identifier'].includes(x.type));
    if (!inner) return null;
    if (inner.type === 'identifier') return inner.text;
    const open = inner.type === 'jsx_element' ? inner.children.find((c) => c.type === 'jsx_opening_element') : inner;
    return getJsxName(open);
  }
  return null;
}

function parseUrl(u) {
  if (!u) return null;
  if (u.startsWith('http://') || u.startsWith('https://')) { try { const p = new URL(u); return { service: p.hostname, path: p.pathname }; } catch { return null; } }
  if (u.startsWith('/')) return { service: '*', path: u.split('?')[0] };
  return null;
}
function optionsMethod(argNode) {
  if (!argNode || argNode.type !== 'object') return null;
  for (const pair of argNode.children) {
    if (pair.type === 'pair') {
      const k = pair.childForFieldName('key'); const v = pair.childForFieldName('value');
      if (k && k.text === 'method' && v) return (strVal(v) || '').toUpperCase() || null;
    }
  }
  return null;
}
function httpCall(node) {
  if (node.type !== 'call_expression') return null;
  const fn = node.childForFieldName('function'); const args = node.childForFieldName('arguments');
  if (!fn || !args) return null;
  const a = args.children.filter((c) => !['(', ')', ','].includes(c.type));
  if (fn.type === 'identifier' && fn.text === 'fetch') return urlCall(strVal(a[0]), optionsMethod(a[1]) || 'GET');
  if (fn.type === 'identifier' && fn.text === 'axios') return urlCall(strVal(a[0]), optionsMethod(a[1]) || 'GET');
  if (fn.type === 'member_expression') {
    const obj = fn.childForFieldName('object'); const prop = fn.childForFieldName('property');
    if (obj && prop && obj.text === 'axios' && ['get', 'post', 'put', 'delete', 'patch'].includes(prop.text)) return urlCall(strVal(a[0]), prop.text.toUpperCase());
  }
  return null;
}
function urlCall(url, method) { const p = parseUrl(url); return p ? { service: p.service, method, path: p.path } : null; }
function hookName(node) {
  if (node.type !== 'call_expression') return null;
  const fn = node.childForFieldName('function');
  return fn && fn.type === 'identifier' && /^use[A-Z]/.test(fn.text) ? fn.text : null;
}

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']);

// Next.js API route handlers (these ARE backend endpoints):
//   app/<segs>/route.ts -> exported GET/POST/... functions => method per export
//   pages/api/<segs>.ts -> default handler; methods from req.method checks (else ANY)
function nextApi(rel, tree) {
  const n = rel.replaceAll('\\', '/');
  const dyn = (p) => p.replace(/\[(?:\.\.\.)?([^\]]+)\]/g, '{$1}');
  let m;
  if ((m = n.match(/(?:^|\/)app\/(.+)\/route\.[tj]sx?$/))) {
    const path = `/${dyn(m[1])}`;
    const methods = new Set();
    for (const fn of tree.rootNode.descendantsOfType('function_declaration')) {
      const nm = fn.childForFieldName('name'); if (nm && HTTP_METHODS.has(nm.text)) methods.add(nm.text);
    }
    for (const vd of tree.rootNode.descendantsOfType('variable_declarator')) {
      const nm = vd.childForFieldName('name'); const v = vd.childForFieldName('value');
      if (nm && HTTP_METHODS.has(nm.text) && v && ['arrow_function', 'function_expression'].includes(v.type)) methods.add(nm.text);
    }
    return { path, methods: methods.size ? [...methods] : ['GET'] };
  }
  if ((m = n.match(/(?:^|\/)pages\/api\/(.+)\.[tj]sx?$/))) {
    let seg = m[1]; if (seg.endsWith('/index')) seg = seg.slice(0, -6);
    const path = `/api/${dyn(seg)}`.replace(/\/$/, '') || '/api';
    const methods = [...new Set([...tree.rootNode.text.matchAll(/req\.method\s*===?\s*['"`](GET|POST|PUT|DELETE|PATCH)['"`]/g)].map((x) => x[1]))];
    return { path, methods: methods.length ? methods : ['ANY'] };
  }
  return null;
}

function nextRoute(rel) {
  const n = rel.replaceAll('\\', '/');
  const dyn = (p) => p.replace(/\[(?:\.\.\.)?([^\]]+)\]/g, '{$1}');
  let m;
  if ((m = n.match(/(?:^|\/)app\/(.+)\/page\.[tj]sx?$/))) return `/${dyn(m[1])}`;
  if (/(?:^|\/)app\/page\.[tj]sx?$/.test(n)) return '/';
  if ((m = n.match(/(?:^|\/)pages\/(.+)\.[tj]sx?$/))) {
    let p = m[1];
    if (p === 'index' || p === '_app' || p === '_document') return p === 'index' ? '/' : null;
    if (p.startsWith('api/')) return null;
    p = p.replace(/\/index$/, '');
    return `/${dyn(p)}`;
  }
  return null;
}

// NOTE: the tree-sitter parser is a singleton, and re-parsing invalidates
// previously returned trees. So we DO NOT store trees — we record file paths and
// the symbol maps, then re-parse each file fresh at the moment it is walked.
export function parseReactRepo(root) {
  const fileRels = [];
  const compByName = new Map();
  const ctxByName = new Map();
  const push = (map, key, val) => { if (!map.has(key)) map.set(key, []); map.get(key).push(val); };
  for (const abs of discoverReactFiles(root)) {
    const rel = relative(root, abs);
    fileRels.push(rel);
    const tree = tsxParser().parse(readFileSync(abs, 'utf8'));
    const collect = (node) => {
      const cn = componentName(node);
      if (cn) push(compByName, cn, `${rel}#${cn}`);
      const xn = contextNameOf(node);
      if (xn) push(ctxByName, xn, `${rel}#${xn}`);
      for (const ch of node.children) collect(ch);
    };
    collect(tree.rootNode);
  }
  return { fileRels, compByName, ctxByName };
}

export function extractReact(database, root) {
  const { fileRels, compByName, ctxByName } = parseReactRepo(root);
  const uniq = (map, name) => { const ids = map.get(name); return ids && ids.length === 1 ? ids[0] : null; };

  for (const rel of fileRels) {
    const tree = tsxParser().parse(readFileSync(join(root, rel), 'utf8'));
    const moduleId = `module::${rel}`;
    db.upsertNode(database, { id: moduleId, kind: 'module', name: rel, file: rel, layer: 'module' });

    // Next.js file-based page route
    const routePath = nextRoute(rel);
    if (routePath) {
      const rid = `route::${routePath}`;
      db.upsertNode(database, { id: rid, kind: 'route', name: routePath, path: routePath, file: rel, layer: 'route' });
      db.addEdge(database, rid, moduleId, 'routes_to');
    }

    // Next.js API route handlers => backend endpoints (federation-matchable)
    const api = nextApi(rel, tree);
    if (api) {
      for (const method of api.methods) {
        const hid = `${rel}#${method}`;
        db.upsertNode(database, {
          id: hid, kind: 'method', name: `${method} ${api.path}`, file: rel,
          http_method: method, path: api.path, layer: 'controller',
        });
        db.addEdge(database, moduleId, hid, 'routes_to');
      }
    }

    const walk = (node, currentComp) => {
      let comp = currentComp;
      const cn = componentName(node);
      if (cn) {
        comp = `${rel}#${cn}`;
        db.upsertNode(database, {
          id: comp, kind: 'component', name: cn, file: rel, start_line: line(node), end_line: endLine(node),
          layer: 'component', attrs: JSON.stringify({ props: propNames(node) }),
        });
      }
      const xn = contextNameOf(node);
      if (xn) db.upsertNode(database, { id: `${rel}#${xn}`, kind: 'context', name: xn, file: rel, layer: 'context' });
      const src = comp || moduleId;

      if (node.type === 'jsx_opening_element' || node.type === 'jsx_self_closing_element') {
        const tag = getJsxName(node);
        // react-router <Route path=".." element={<Comp/>} />
        if (tag === 'Route') {
          const attrs = jsxAttrs(node);
          const pathAttr = attrs.find((a) => a.name === 'path');
          const elAttr = attrs.find((a) => a.name === 'element' || a.name === 'component');
          const p = pathAttr ? strVal(pathAttr.valNode) : null;
          const targetName = elAttr ? compFromValue(elAttr.valNode) : null;
          if (p) {
            const rid = `route::${p}`;
            db.upsertNode(database, { id: rid, kind: 'route', name: p, path: p, file: rel, layer: 'route' });
            const tgt = targetName ? uniq(compByName, targetName) : null;
            if (tgt) db.addEdge(database, rid, tgt, 'routes_to');
          }
        } else if (tag && tag.endsWith('.Provider')) {
          const ctx = uniq(ctxByName, tag.split('.')[0]);
          if (ctx && comp) db.addEdge(database, comp, ctx, 'provides_context');
        } else if (tag && isComp(tag)) {
          const tgt = uniq(compByName, tag);
          if (tgt && comp && tgt !== comp) {
            const attrs = jsxAttrs(node).map((a) => a.name).filter(Boolean);
            db.addEdge(database, comp, tgt, 'renders');
            if (attrs.length) db.addEdge(database, comp, tgt, 'passes_prop', JSON.stringify({ props: attrs }));
          }
        }
      }

      const hn = hookName(node);
      if (hn) {
        const hid = `hook::${hn}`;
        db.upsertNode(database, { id: hid, kind: 'hook', name: hn, layer: 'hook' });
        db.addEdge(database, src, hid, 'uses_hook');
        if (hn === 'useContext') {
          const arg = node.childForFieldName('arguments')?.children.find((c) => c.type === 'identifier');
          const ctx = arg ? uniq(ctxByName, arg.text) : null;
          if (ctx) db.addEdge(database, src, ctx, 'uses_context');
        }
      }

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
