// Outbound (cross-service) call extraction for Java backends.
//   - OpenFeign: @FeignClient(name=...) interfaces + mapping methods
//   - RestTemplate: getForObject/postForObject/... to http://<service>/<path>
// Recorded as external_endpoint nodes + calls_service edges for federation.
import * as db from './db.js';
import { methodNodeId } from './extractJava.js';
import { MAPPING_METHOD, pathFromArgs, joinPath } from './spring.js';

const REST_TEMPLATE_HTTP = {
  getForObject: 'GET', getForEntity: 'GET',
  postForObject: 'POST', postForEntity: 'POST', postForLocation: 'POST',
  put: 'PUT', delete: 'DELETE', patchForObject: 'PATCH',
};
const HTTP_CLIENT_TYPES = new Set(['RestTemplate', 'TestRestTemplate']);

const strArg = (args, key) => { const m = args.match(new RegExp(`${key}\\s*=\\s*"([^"]*)"`)); return m ? m[1] : null; };
const firstLiteral = (args) => { const m = args.match(/"([^"]+)"/); return m ? m[1] : null; };
const norm = (p) => (p.replace(/^\/|\/$/g, '') ? `/${p.replace(/^\/|\/$/g, '')}` : '/');

function feignService(ci) {
  const ann = ci.annotation('FeignClient');
  if (!ann) return null;
  const a = ann.argsText || '';
  return strArg(a, 'name') || strArg(a, 'value') || firstLiteral(a);
}

function recordOutbound(database, srcId, service, method, path, via) {
  const extId = `external::${service}::${method} ${norm(path)}`;
  db.upsertNode(database, {
    id: extId, kind: 'external_endpoint', name: `${method} ${norm(path)}`,
    http_method: method, path: norm(path), service,
    attrs: JSON.stringify({ target_service: service, http_method: method, path: norm(path), via, resolved: false }),
  });
  db.addEdge(database, srcId, extId, 'calls_service',
    JSON.stringify({ target_service: service, http_method: method, path: norm(path), via }));
}

export function apply(database, classes) {
  for (const ci of classes) {
    const svc = feignService(ci);
    if (svc) applyFeign(database, ci, svc);
    applyRestTemplate(database, ci);
  }
}

function applyFeign(database, ci, service) {
  const classRm = ci.annotation('RequestMapping');
  const prefix = classRm ? pathFromArgs(classRm.argsText) : '';
  for (const m of ci.methods) {
    for (const ann of m.annotations) {
      if (MAPPING_METHOD[ann.name]) {
        recordOutbound(database, methodNodeId(ci.id, m), service, MAPPING_METHOD[ann.name], joinPath(prefix, pathFromArgs(ann.argsText) || ''), 'feign');
        break;
      }
      if (ann.name === 'RequestMapping') {
        const mm = ann.argsText.match(/RequestMethod\.(\w+)/);
        recordOutbound(database, methodNodeId(ci.id, m), service, mm ? mm[1] : 'GET', joinPath(prefix, pathFromArgs(ann.argsText) || ''), 'feign');
        break;
      }
    }
  }
}

function applyRestTemplate(database, ci) {
  for (const m of ci.methods) {
    const env = {};
    for (const f of ci.fields) if (f.typeSimple) env[f.name] = f.typeSimple;
    for (const [pn, pt] of m.params) if (pt) env[pn] = pt;
    Object.assign(env, m.locals);
    for (const inv of m.invocations) {
      if (!REST_TEMPLATE_HTTP[inv.method]) continue;
      const rtype = inv.receiver ? env[inv.receiver] : null;
      if (!HTTP_CLIENT_TYPES.has(rtype)) continue;
      const url = inv.strArgs.find((a) => a.startsWith('http://') || a.startsWith('https://'));
      if (!url) continue;
      let parsed; try { parsed = new URL(url); } catch { continue; }
      const service = parsed.hostname;
      if (!service || parsed.pathname === '' || parsed.pathname === '/') continue;
      recordOutbound(database, methodNodeId(ci.id, m), service, REST_TEMPLATE_HTTP[inv.method], parsed.pathname, 'resttemplate');
    }
  }
}
