#!/usr/bin/env node
// code-kg CLI: index | reindex | enrich | serve | digest | federate
import './quiet.js';
import { existsSync, writeFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import * as db from './db.js';
import { federate } from './federate.js';
import { buildGraph, findRepoRoot, fileSignature } from './build.js';

function printCounts(c) {
  console.log(`  classes=${c.classes} components=${c.components} methods=${c.methods} `
    + `endpoints=${c.endpoints} injects=${c.injects} calls_service=${c.calls_service} `
    + `edges=${c.edges} features=${c.features}`);
}

// --- commands ---
function cmdIndex(opts) {
  const source = resolve(opts._[0]);
  const repoRoot = findRepoRoot(source);
  const dbFile = db.resolveDbPath(repoRoot, opts.db);
  const database = db.connect(dbFile); db.initSchema(database);
  const { counts, kinds, svc } = buildGraph(database, source, opts.service);
  database.close();
  console.log(`Indexed ${source}  (service: ${svc}; ${kinds.join(' + ') || 'none'})`);
  console.log(`  graph.db: ${dbFile}`);
  printCounts(counts);
}

function cmdReindex(opts) {
  const repoRoot = findRepoRoot(opts.repo || process.cwd());
  const dbFile = db.resolveDbPath(repoRoot, opts.db);
  if (!existsSync(dbFile)) { console.error(`No graph at ${dbFile}; run \`code-kg index\` first.`); process.exit(1); }
  const database = db.connect(dbFile); db.initSchema(database);
  let sourceRoot = opts._[0] ? resolve(opts._[0]) : db.getMeta(database, 'source_root');
  if (!sourceRoot) { console.error('No source root recorded; pass a path.'); process.exit(1); }
  const old = JSON.parse(db.getMeta(database, 'file_mtimes') || '{}');
  const next = fileSignature(sourceRoot);
  const changed = [...new Set([...Object.keys(old), ...Object.keys(next)])].filter((f) => old[f] !== next[f]);
  const service = opts.service || db.getMeta(database, 'service');
  const { counts } = buildGraph(database, sourceRoot, service);
  database.close();
  console.log(changed.length ? `Reindexed; ${changed.length} file(s) changed.` : 'Reindexed; no changes detected.');
  printCounts(counts);
}

async function cmdEnrich(opts) {
  const enrich = await import('./enrich.js');
  const repoRoot = findRepoRoot(opts.repo || process.cwd());
  const dbFile = db.resolveDbPath(repoRoot, opts.db);
  if (!existsSync(dbFile)) { console.error(`No graph at ${dbFile}; run \`code-kg index\` first.`); process.exit(1); }
  const database = db.connect(dbFile); db.initSchema(database);
  try {
    const r = await enrich.enrich(database, {
      deployment: opts.deployment, apiKey: opts['api-key'], endpoint: opts.endpoint, apiVersion: opts['api-version'],
    });
    console.log(`Enrichment complete: ${r.features_written} feature(s) written, ${r.features_rejected} rejected; `
      + `${r.summaries_written} summary(ies) written, ${r.summaries_rejected} rejected (anti-hallucination gate).`);
  } catch (e) { console.error(`Enrichment skipped: ${e.message}`); database.close(); process.exit(1); }
  database.close();
}

async function cmdServe(opts) {
  const server = await import('./server.js');
  const repoRoot = findRepoRoot(opts.repo || process.cwd());
  const dbFile = db.resolveDbPath(repoRoot, opts.db);
  if (!existsSync(dbFile)) { console.error(`No graph at ${dbFile}; run \`code-kg index\` first.`); process.exit(1); }
  await server.serve(dbFile);
}

function cmdFederate(opts) {
  const services = [];
  for (const repo of opts._) {
    const repoRoot = findRepoRoot(resolve(repo));
    const dbFile = db.resolveDbPath(repoRoot, null);
    if (!existsSync(dbFile)) { console.error(`No graph for ${repo} at ${dbFile}; run \`code-kg index\` first.`); process.exit(1); }
    const d = db.connectRO(dbFile);
    const name = db.getMeta(d, 'service') || basename(repoRoot);
    d.close();
    services.push({ name, dbPath: dbFile });
  }
  if (!opts.output) { console.error('federate requires -o <merged.db>'); process.exit(1); }
  const out = resolve(opts.output);
  const r = federate(out, services);
  console.log(`Federated ${r.services.length} services: ${r.services.join(', ')}`);
  console.log(`  merged graph.db: ${out}`);
  console.log(`  cross-service links: ${r.links_resolved} resolved, ${r.links_unresolved} unresolved`);
  console.log(`  serve with: code-kg serve --db ${out}`);
}

function cmdDigest(opts) {
  const repoRoot = findRepoRoot(opts.repo || process.cwd());
  const dbFile = db.resolveDbPath(repoRoot, opts.db);
  if (!existsSync(dbFile)) { console.error(`No graph at ${dbFile}; run \`code-kg index\` first.`); process.exit(1); }
  const database = db.connectRO(dbFile);
  const text = renderDigest(database);
  database.close();
  if (opts.output) { writeFileSync(opts.output, text); console.log(`Wrote ${opts.output}`); } else console.log(text);
}

function renderDigest(c) {
  const L = [];
  const counts = db.counts(c);
  L.push('# Architecture (code-kg digest)', '', '> Generated from the code knowledge graph — derived deterministically from source.', '');
  L.push('## Overview', '');
  L.push(`- Classes/interfaces/enums: **${counts.classes}**`, `- React components: **${counts.components}**`,
    `- HTTP endpoints: **${counts.endpoints}**`, `- DI (injects) edges: **${counts.injects}**`,
    `- Cross-service calls: **${counts.calls_service}**`, `- Total edges: **${counts.edges}**`, '');
  L.push('## Layers', '');
  for (const r of c.prepare("SELECT layer, COUNT(*) n FROM nodes WHERE kind IN ('class','interface','enum','component') AND layer IS NOT NULL GROUP BY layer ORDER BY n DESC").all()) {
    const names = c.prepare("SELECT name FROM nodes WHERE layer=? AND kind IN ('class','interface','enum','component') ORDER BY name").all(r.layer).map((x) => x.name);
    L.push(`- **${r.layer}** (${r.n}): ${names.join(', ')}`);
  }
  L.push('');
  const eps = c.prepare("SELECT http_method, path, name, file FROM nodes WHERE http_method IS NOT NULL AND kind!='external_endpoint' ORDER BY path").all();
  if (eps.length) {
    L.push('## HTTP Endpoints', '', '| Method | Path | Handler | File |', '|---|---|---|---|');
    for (const e of eps) L.push(`| ${e.http_method} | \`${e.path}\` | ${e.name} | \`${basename(e.file || '')}\` |`);
    L.push('');
  }
  // data model
  const entities = c.prepare("SELECT name, attrs FROM nodes WHERE layer='entity' AND kind IN ('class','interface','enum') ORDER BY name").all();
  if (entities.length) {
    L.push('## Data Model (JPA / Hibernate)', '');
    for (const e of entities) {
      const a = e.attrs ? JSON.parse(e.attrs) : {};
      L.push(`### ${e.name} — table \`${a.table || e.name}\``, '');
      if ((a.columns || []).length) {
        L.push('| Column | Type | PK | Constraints |', '|---|---|---|---|');
        for (const col of a.columns) {
          const flags = [];
          if (col.generated) flags.push(`generated=${col.generated}`);
          if (col.nullable === false) flags.push('not-null');
          if (col.unique) flags.push('unique');
          if (col.length) flags.push(`len=${col.length}`);
          for (const f of ['lob', 'enumerated', 'version', 'embedded', 'transient']) if (col[f]) flags.push(f);
          L.push(`| \`${col.column}\` | ${col.type} | ${col.primary_key ? '✓' : ''} | ${flags.join(', ')} |`);
        }
      }
      L.push('');
    }
    const rels = c.prepare("SELECT s.name s, d.name d, e.kind k, e.attrs a FROM edges e JOIN nodes s ON s.id=e.src JOIN nodes d ON d.id=e.dst WHERE e.kind IN ('one_to_many','many_to_one','one_to_one','many_to_many') ORDER BY s.name").all();
    if (rels.length) {
      L.push('### Relationships', '');
      for (const r of rels) {
        const a = r.a ? JSON.parse(r.a) : {};
        const detail = [`fetch=${a.fetch}`, a.owning ? 'owning' : 'inverse'];
        if (a.mapped_by) detail.push(`mappedBy=${a.mapped_by}`);
        if (a.cascade) detail.push(`cascade=${a.cascade.join('|')}`);
        if (a.join_column) detail.push(`join=${a.join_column}`);
        L.push(`- \`${r.s}\` —${r.k}→ \`${r.d}\`  (${detail.join(', ')})`);
      }
      L.push('');
    }
    const repos = c.prepare("SELECT s.name s, d.name d FROM edges e JOIN nodes s ON s.id=e.src JOIN nodes d ON d.id=e.dst WHERE e.kind='persists' ORDER BY s.name").all();
    if (repos.length) { L.push('### Repositories', ''); for (const r of repos) L.push(`- \`${r.s}\` manages \`${r.d}\``); L.push(''); }
  }
  // service map (federated)
  const remoteEdges = c.prepare("SELECT s.name s, ss.service fs, d.name d, ds.service ts, e.attrs a FROM edges e JOIN nodes s ON s.id=e.src JOIN nodes ss ON ss.id=e.src JOIN nodes d ON d.id=e.dst JOIN nodes ds ON ds.id=e.dst WHERE e.kind='calls_remote' ORDER BY ss.service").all();
  if (remoteEdges.length) {
    L.push('## Cross-Service Calls', '');
    for (const r of remoteEdges) {
      const a = r.a ? JSON.parse(r.a) : {};
      L.push(`- \`${r.fs}\` → \`${r.ts}\`  (${a.http_method} ${a.path})`);
    }
    L.push('');
  }
  const feats = c.prepare('SELECT id, name, description FROM features ORDER BY name').all();
  if (feats.length) {
    L.push('## Features', '');
    for (const f of feats) {
      L.push(`### ${f.name}`);
      if (f.description) L.push('', f.description);
      L.push('');
      for (const ff of c.prepare('SELECT DISTINCT file FROM feature_files WHERE feature_id=? ORDER BY file').all(f.id)) L.push(`- \`${ff.file}\``);
      L.push('');
    }
  }
  return L.join('\n');
}

// --- minimal arg parser ---
function parse(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const nxt = argv[i + 1];
      if (nxt === undefined || nxt.startsWith('--')) opts[key] = true;
      else { opts[key] = nxt; i += 1; }
    } else if (a === '-o') { opts.output = argv[i + 1]; i += 1; } else opts._.push(a);
  }
  return opts;
}

const COMMANDS = {
  index: cmdIndex, reindex: cmdReindex, enrich: cmdEnrich, serve: cmdServe, federate: cmdFederate, digest: cmdDigest,
};

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const fn = COMMANDS[cmd];
  if (!fn) {
    console.error('usage: code-kg <index|reindex|enrich|serve|digest|federate> [args]');
    process.exit(cmd ? 1 : 0);
  }
  await fn(parse(rest));
}

main().catch((e) => { console.error(e); process.exit(1); });
