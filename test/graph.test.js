import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as db from '../src/db.js';
import { buildGraph } from '../src/build.js';
import { federate } from '../src/federate.js';
import * as server from '../src/server.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FX = join(HERE, '..', 'tests', 'fixtures');

function indexInto(name, src) {
  const dir = mkdtempSync(join(tmpdir(), 'kg-'));
  const dbFile = join(dir, `${name}.db`);
  const d = db.connect(dbFile); db.initSchema(d);
  buildGraph(d, src, name);
  d.close();
  return dbFile;
}
const ro = (f) => db.connectRO(f);

// ---------- Java / Spring ----------
test('java: classes, endpoints, injects, static call', () => {
  const f = indexInto('demo', join(FX, 'demo', 'src', 'main', 'java'));
  const c = ro(f);
  assert.equal(c.prepare("SELECT COUNT(*) n FROM nodes WHERE kind IN ('class','interface','enum')").get().n, 9);
  const eps = new Set(c.prepare("SELECT http_method||' '||path p FROM nodes WHERE http_method IS NOT NULL").all().map((r) => r.p));
  assert.ok(eps.has('GET /api/orders/sorted'));
  assert.ok(eps.has('POST /api/transform'));
  const injects = new Set(c.prepare("SELECT s.name||'->'||d.name e FROM edges e JOIN nodes s ON s.id=e.src JOIN nodes d ON d.id=e.dst WHERE e.kind='injects'").all().map((r) => r.e));
  assert.ok(injects.has('OrderController->OrderService'));
  assert.ok(injects.has('GreetingService->GreetingDao'));
  // static call GreetingService.greet -> StringUtils.shout/reverse
  const dsts = new Set(c.prepare("SELECT d.name n FROM edges e JOIN nodes s ON s.id=e.src JOIN nodes d ON d.id=e.dst WHERE e.kind='calls' AND s.name='greet' AND d.kind='method'").all().map((r) => r.n));
  assert.ok(dsts.has('shout') && dsts.has('reverse'));
  c.close();
});

// ---------- JPA / Hibernate ----------
test('jpa: entities, relationships with mapping, repository', () => {
  const f = indexInto('shop', join(FX, 'shop', 'src', 'main', 'java'));
  server.setDb(f);
  const dm = server.kgDataModel();
  assert.deepEqual(new Set(dm.entities.map((e) => e.entity)), new Set(['Customer', 'Purchase', 'Address']));
  const by = {};
  for (const r of dm.relationships) by[`${r.from}.${r.kind}.${r.to}`] = r;
  assert.equal(by['Customer.one_to_many.Purchase'].owning, false);
  assert.equal(by['Customer.one_to_many.Purchase'].mapped_by, 'customer');
  assert.deepEqual(by['Customer.one_to_many.Purchase'].cascade, ['ALL']);
  assert.equal(by['Purchase.many_to_one.Customer'].join_column, 'customer_id');
  assert.ok(dm.repositories.some((r) => r.repository === 'PurchaseRepository' && r.manages_entity === 'Purchase'));
  const ent = server.kgEntity('Customer');
  assert.equal(ent.table, 'customers');
  assert.equal(ent.columns.find((x) => x.column === 'id').generated, 'IDENTITY');
});

// ---------- React ----------
test('react: components, hooks, renders, api calls', () => {
  const f = indexInto('web-ui', join(FX, 'ms', 'web-ui'));
  const c = ro(f);
  const comps = new Set(c.prepare("SELECT name FROM nodes WHERE kind='component'").all().map((r) => r.name));
  assert.ok(comps.has('App') && comps.has('RegisterForm'));
  // hooks
  const hooks = new Set(c.prepare("SELECT n.name nm FROM edges e JOIN nodes n ON n.id=e.dst WHERE e.kind='uses_hook'").all().map((r) => r.nm));
  assert.ok(hooks.has('useState') && hooks.has('useEffect'));
  // App renders RegisterForm
  const renders = c.prepare("SELECT COUNT(*) n FROM edges WHERE kind='renders'").get().n;
  assert.ok(renders >= 1);
  // outbound api calls -> external endpoints
  const ext = new Set(c.prepare("SELECT http_method||' '||path p FROM nodes WHERE kind='external_endpoint'").all().map((r) => r.p));
  assert.ok(ext.has('POST /users/register'));
  assert.ok(ext.has('GET /auth/validate'));
  c.close();
});

test('react: routes, context, props data flow', () => {
  const f = indexInto('web-ui', join(FX, 'ms', 'web-ui'));
  const c = ro(f);
  // react-router routes -> components
  const routes = new Set(c.prepare("SELECT path FROM nodes WHERE kind='route'").all().map((r) => r.path));
  assert.ok(routes.has('/home') && routes.has('/register'));
  const routeEdges = new Set(c.prepare("SELECT s.path||'->'||d.name e FROM edges e JOIN nodes s ON s.id=e.src JOIN nodes d ON d.id=e.dst WHERE e.kind='routes_to' AND s.kind='route'").all().map((r) => r.e));
  assert.ok(routeEdges.has('/home->App'));
  assert.ok(routeEdges.has('/register->RegisterForm'));
  // context
  assert.ok(c.prepare("SELECT 1 FROM nodes WHERE kind='context' AND name='AuthContext'").get());
  const usesCtx = c.prepare("SELECT s.name s FROM edges e JOIN nodes s ON s.id=e.src JOIN nodes d ON d.id=e.dst WHERE e.kind='uses_context' AND d.name='AuthContext'").all().map((r) => r.s);
  assert.ok(usesCtx.includes('RegisterForm'));
  assert.ok(c.prepare("SELECT 1 FROM edges e JOIN nodes s ON s.id=e.src JOIN nodes d ON d.id=e.dst WHERE e.kind='provides_context' AND s.name='AuthProvider' AND d.name='AuthContext'").get());
  // props data flow: App passes `title` to RegisterForm; RegisterForm declares prop `title`
  const pp = c.prepare("SELECT e.attrs attrs FROM edges e JOIN nodes s ON s.id=e.src JOIN nodes d ON d.id=e.dst WHERE e.kind='passes_prop' AND s.name='App' AND d.name='RegisterForm'").get();
  assert.ok(pp && JSON.parse(pp.attrs).props.includes('title'));
  const rf = c.prepare("SELECT attrs FROM nodes WHERE kind='component' AND name='RegisterForm'").get();
  assert.ok(JSON.parse(rf.attrs).props.includes('title'));
  c.close();
});

// ---------- Full-stack federation ----------
test('federation: frontend + backends linked, flow crosses tiers', () => {
  const login = indexInto('login-service', join(FX, 'ms', 'login-service', 'src', 'main', 'java'));
  const user = indexInto('user-service', join(FX, 'ms', 'user-service', 'src', 'main', 'java'));
  const web = indexInto('web-ui', join(FX, 'ms', 'web-ui'));
  const dir = mkdtempSync(join(tmpdir(), 'kg-'));
  const merged = join(dir, 'merged.db');
  const report = federate(merged, [
    { name: 'web-ui', dbPath: web },
    { name: 'user-service', dbPath: user },
    { name: 'login-service', dbPath: login },
  ]);
  // web->user (register), web->login (validate), user->login (feign login + rest validate) = 4
  assert.ok(report.links_resolved >= 4, `resolved=${report.links_resolved}`);

  server.setDb(merged);
  const sm = server.kgServiceMap();
  assert.deepEqual(new Set(sm.services), new Set(['web-ui', 'user-service', 'login-service']));
  const webDeps = sm.dependencies.filter((d) => d.from === 'web-ui');
  const webTargets = new Set(webDeps.map((d) => d.to));
  assert.ok(webTargets.has('user-service'));   // fetch('/users/register')
  assert.ok(webTargets.has('login-service'));  // axios.get('/auth/validate')

  // request flow from the frontend component crosses into backends
  const flow = server.kgRequestFlow('/users/register', 'POST');
  assert.equal(flow.entry.service, 'user-service');
  assert.ok(flow.services_touched.includes('login-service'));
});

// ---------- backend-only federation (order independence) ----------
test('federation order-independent (backend feign + resttemplate)', () => {
  const login = indexInto('login-service', join(FX, 'ms', 'login-service', 'src', 'main', 'java'));
  const user = indexInto('user-service', join(FX, 'ms', 'user-service', 'src', 'main', 'java'));
  const d1 = mkdtempSync(join(tmpdir(), 'kg-'));
  const d2 = mkdtempSync(join(tmpdir(), 'kg-'));
  const a = federate(join(d1, 'm.db'), [{ name: 'login-service', dbPath: login }, { name: 'user-service', dbPath: user }]);
  const b = federate(join(d2, 'm.db'), [{ name: 'user-service', dbPath: user }, { name: 'login-service', dbPath: login }]);
  assert.equal(a.links_resolved, b.links_resolved);
  assert.ok(a.links_resolved >= 2);
});

// ---------- anti-hallucination gate ----------
test('enrich gate rejects unknown file/node', async () => {
  const enrich = await import('../src/enrich.js');
  const f = indexInto('demo', join(FX, 'demo', 'src', 'main', 'java'));
  const d = db.connect(f);
  assert.throws(() => enrich.writeFeature(d, 'llm:x', 'Bogus', '', ['does/not/Exist.java']), enrich.EnrichmentRejected);
  assert.throws(() => enrich.writeSummary(d, 'com.example.demo.Nope', 'x'), enrich.EnrichmentRejected);
  // accepts a known node summary, surfaces via kg_describe
  enrich.writeSummary(d, 'com.example.demo.service.OrderService', 'Serves orders.');
  d.close();
  server.setDb(f);
  assert.equal(server.kgDescribe('OrderService').summary, 'Serves orders.');
});
