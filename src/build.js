// Graph build orchestration (shared by the CLI and tests).
import { existsSync, statSync } from 'node:fs';
import { resolve, dirname, basename, join } from 'node:path';
import * as db from './db.js';
import * as extractJava from './extractJava.js';
import * as spring from './spring.js';
import * as jpa from './jpa.js';
import * as remote from './remote.js';
import { extractReact, discoverReactFiles } from './reactExtract.js';

export function findRepoRoot(p) {
  let cur = resolve(p);
  try { if (statSync(cur).isFile()) cur = dirname(cur); } catch { /* ignore */ }
  for (;;) {
    if (existsSync(join(cur, '.git'))) return cur;
    const parent = dirname(cur);
    if (parent === cur) return resolve(p);
    cur = parent;
  }
}

export function fileSignature(root) {
  const sig = {};
  for (const p of [...extractJava.discoverJavaFiles(root), ...discoverReactFiles(root)]) {
    try { sig[p] = statSync(p).mtimeMs; } catch { /* ignore */ }
  }
  return sig;
}

export function buildGraph(database, sourceRoot, service) {
  db.reset(database);
  const javaFiles = extractJava.discoverJavaFiles(sourceRoot);
  const reactFiles = discoverReactFiles(sourceRoot);
  const kinds = [];
  if (javaFiles.length) {
    const { classes, symbols } = extractJava.parseRepo(sourceRoot);
    extractJava.writeStructure(database, classes, symbols);
    spring.apply(database, classes, symbols);
    jpa.apply(database, classes, symbols);
    remote.apply(database, classes);
    kinds.push('java/spring');
  }
  if (reactFiles.length) { extractReact(database, sourceRoot); kinds.push('react'); }
  spring.buildFallbackFeatures(database);

  const svc = service || basename(findRepoRoot(sourceRoot));
  database.prepare('UPDATE nodes SET service = ? WHERE service IS NULL').run(svc);
  db.setMeta(database, 'service', svc);
  db.setMeta(database, 'kinds', kinds.join(','));
  db.setMeta(database, 'source_root', resolve(sourceRoot));
  db.setMeta(database, 'indexed_at', String(Date.now()));
  db.setMeta(database, 'file_mtimes', JSON.stringify(fileSignature(sourceRoot)));
  return { counts: db.counts(database), kinds, svc };
}
