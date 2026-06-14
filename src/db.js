// SQLite schema + helpers for the code knowledge graph (node:sqlite, no native dep).
//
// One file per indexed service at <repo>/.code-kg/graph.db (gitignored). The
// schema is intentionally light: nodes + edges form the generic spine, with JSON
// `attrs` carrying structured detail (JPA mapping, relationship semantics, etc.),
// `service` for federation namespacing, plus features / feature_files.

import { DatabaseSync } from 'node:sqlite';
import { dirname, join, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

export const DEFAULT_DB_RELPATH = join('.code-kg', 'graph.db');

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS nodes (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,          -- class|interface|enum|method|field|component|hook|module|external_endpoint
  name        TEXT NOT NULL,
  file        TEXT,
  package     TEXT,
  signature   TEXT,
  start_line  INTEGER,
  end_line    INTEGER,
  annotations TEXT,
  layer       TEXT,                   -- controller|service|repository|dao|config|model|util|entity|component|hook|...
  http_method TEXT,
  path        TEXT,
  summary     TEXT,
  attrs       TEXT,                   -- JSON structured detail
  service     TEXT                    -- owning service (frontend or backend) for federation
);

CREATE TABLE IF NOT EXISTS edges (
  src   TEXT NOT NULL,
  dst   TEXT NOT NULL,
  kind  TEXT NOT NULL,                -- calls|imports|extends|implements|injects|routes_to|persists
                                      --   |one_to_many|many_to_one|one_to_one|many_to_many
                                      --   |calls_service|calls_remote|renders|uses_hook
  attrs TEXT,
  PRIMARY KEY (src, dst, kind)
);

CREATE TABLE IF NOT EXISTS features (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT);
CREATE TABLE IF NOT EXISTS feature_files (
  feature_id TEXT NOT NULL, file TEXT NOT NULL, entry_node_id TEXT,
  PRIMARY KEY (feature_id, file, entry_node_id)
);

CREATE INDEX IF NOT EXISTS idx_nodes_kind    ON nodes(kind);
CREATE INDEX IF NOT EXISTS idx_nodes_name    ON nodes(name);
CREATE INDEX IF NOT EXISTS idx_nodes_file    ON nodes(file);
CREATE INDEX IF NOT EXISTS idx_nodes_layer   ON nodes(layer);
CREATE INDEX IF NOT EXISTS idx_nodes_service ON nodes(service);
CREATE INDEX IF NOT EXISTS idx_edges_src     ON edges(src);
CREATE INDEX IF NOT EXISTS idx_edges_dst     ON edges(dst);
CREATE INDEX IF NOT EXISTS idx_edges_kind    ON edges(kind);
`;

const NODE_COLS = [
  'id', 'kind', 'name', 'file', 'package', 'signature', 'start_line', 'end_line',
  'annotations', 'layer', 'http_method', 'path', 'summary', 'attrs', 'service',
];

export function resolveDbPath(repo, dbPath) {
  if (dbPath) return resolve(dbPath);
  return resolve(join(repo, DEFAULT_DB_RELPATH));
}

export function connect(dbFile) {
  mkdirSync(dirname(resolve(dbFile)), { recursive: true });
  const db = new DatabaseSync(dbFile);
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}

export function initSchema(db) {
  db.exec(SCHEMA);
}

export function connectRO(dbFile) {
  // node:sqlite has no read-only flag; open normally and treat as read-only by convention.
  const db = new DatabaseSync(dbFile);
  return db;
}

export function reset(db) {
  for (const t of ['edges', 'nodes', 'feature_files', 'features', 'meta']) {
    db.exec(`DELETE FROM ${t}`);
  }
}

export function upsertNode(db, node) {
  const vals = NODE_COLS.map((c) => (node[c] === undefined ? null : node[c]));
  const placeholders = NODE_COLS.map(() => '?').join(', ');
  const updates = NODE_COLS.filter((c) => c !== 'id').map((c) => `${c}=excluded.${c}`).join(', ');
  db.prepare(
    `INSERT INTO nodes (${NODE_COLS.join(', ')}) VALUES (${placeholders}) ` +
    `ON CONFLICT(id) DO UPDATE SET ${updates}`,
  ).run(...vals);
}

export function addEdge(db, src, dst, kind, attrs = null) {
  db.prepare(
    'INSERT INTO edges (src, dst, kind, attrs) VALUES (?, ?, ?, ?) ' +
    'ON CONFLICT(src, dst, kind) DO UPDATE SET attrs=COALESCE(excluded.attrs, attrs)',
  ).run(src, dst, kind, attrs);
}

export function setNodeAttrs(db, id, attrs) {
  db.prepare('UPDATE nodes SET attrs = ? WHERE id = ?').run(attrs, id);
}

export function setMeta(db, key, value) {
  db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
  ).run(key, value);
}

export function getMeta(db, key) {
  const r = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return r ? r.value : null;
}

export function nodeIds(db) {
  return new Set(db.prepare('SELECT id FROM nodes').all().map((r) => r.id));
}

export function files(db) {
  return new Set(
    db.prepare('SELECT DISTINCT file FROM nodes WHERE file IS NOT NULL').all().map((r) => r.file),
  );
}

export function counts(db) {
  const one = (sql) => db.prepare(sql).get().c;
  return {
    classes: one("SELECT COUNT(*) c FROM nodes WHERE kind IN ('class','interface','enum')"),
    components: one("SELECT COUNT(*) c FROM nodes WHERE kind = 'component'"),
    methods: one("SELECT COUNT(*) c FROM nodes WHERE kind = 'method'"),
    endpoints: one('SELECT COUNT(*) c FROM nodes WHERE http_method IS NOT NULL'),
    edges: one('SELECT COUNT(*) c FROM edges'),
    injects: one("SELECT COUNT(*) c FROM edges WHERE kind = 'injects'"),
    routes_to: one("SELECT COUNT(*) c FROM edges WHERE kind = 'routes_to'"),
    calls_service: one("SELECT COUNT(*) c FROM edges WHERE kind = 'calls_service'"),
    features: one('SELECT COUNT(*) c FROM features'),
  };
}
