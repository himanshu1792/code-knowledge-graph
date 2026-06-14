// JPA / Hibernate pass: entities + tables, relationships (cascade/fetch/mappedBy/
// owning/join), and Spring Data repositories linked to the entity they manage.
import * as db from './db.js';

const RELATION_ANNS = {
  OneToMany: 'one_to_many', ManyToOne: 'many_to_one',
  OneToOne: 'one_to_one', ManyToMany: 'many_to_many',
};
const COLLECTION_RELATIONS = new Set(['one_to_many', 'many_to_many']);
const DEFAULT_FETCH = {
  one_to_many: 'LAZY', many_to_many: 'LAZY', many_to_one: 'EAGER', one_to_one: 'EAGER',
};
const REPO_BASES = new Set([
  'JpaRepository', 'CrudRepository', 'PagingAndSortingRepository',
  'ReactiveCrudRepository', 'Repository', 'JpaSpecificationExecutor',
]);

const simple = (n) => (n.includes('.') ? n.split('.').pop() : n);
const strArg = (args, key) => { const m = args.match(new RegExp(`${key}\\s*=\\s*"([^"]*)"`)); return m ? m[1] : null; };
const boolArg = (args, key) => { const m = args.match(new RegExp(`${key}\\s*=\\s*(true|false)`)); return m ? m[1] === 'true' : null; };
const intArg = (args, key) => { const m = args.match(new RegExp(`${key}\\s*=\\s*(\\d+)`)); return m ? Number(m[1]) : null; };
const enumTokens = (args, en) => [...args.matchAll(new RegExp(`${en}\\.(\\w+)`, 'g'))].map((m) => m[1]);
const genericFirst = (s) => { const m = s.match(/<\s*([A-Za-z_][A-Za-z0-9_.]*)/); return m ? simple(m[1]) : null; };

function tableName(ci) {
  const t = ci.annotation('Table');
  if (t && t.argsText) return strArg(t.argsText, 'name') || (t.argsText.match(/"([^"]+)"/)?.[1]) || ci.name;
  return ci.name;
}

export function isEntity(ci) { return ci.hasAnnotation('Entity'); }

export function repositoryEntity(ci) {
  for (const raw of ci.rawSupertypes) {
    const base = simple(raw.split('<')[0]).trim();
    if (REPO_BASES.has(base) && raw.includes('<')) { const e = genericFirst(raw); if (e) return e; }
  }
  return null;
}

function columnMapping(f) {
  const names = new Set(f.annotations.map((a) => a.name));
  const col = f.annotation('Column');
  const join = f.annotation('JoinColumn');
  const gen = f.annotation('GeneratedValue');
  let columnName = col && col.argsText ? strArg(col.argsText, 'name') : null;
  if (!columnName && join && join.argsText) columnName = strArg(join.argsText, 'name');
  const m = {
    field: f.name, type: f.typeSimple, column: columnName || f.name,
    primary_key: names.has('Id') || names.has('EmbeddedId'),
  };
  if (gen) { const s = enumTokens(gen.argsText || '', 'GenerationType'); m.generated = s[0] || 'AUTO'; }
  if (col && col.argsText) {
    const n = boolArg(col.argsText, 'nullable'); const u = boolArg(col.argsText, 'unique'); const l = intArg(col.argsText, 'length');
    if (n !== null) m.nullable = n; if (u !== null) m.unique = u; if (l !== null) m.length = l;
  }
  for (const [flag, ann] of [['enumerated', 'Enumerated'], ['lob', 'Lob'], ['version', 'Version'], ['embedded', 'Embedded'], ['transient', 'Transient']]) {
    if (names.has(ann)) m[flag] = true;
  }
  return m;
}

function relationAttrs(f, rel) {
  const relAnn = f.annotations.find((a) => RELATION_ANNS[a.name]);
  const args = relAnn ? relAnn.argsText : '';
  const mappedBy = strArg(args, 'mappedBy');
  const fetchExplicit = enumTokens(args, 'FetchType');
  const cascade = enumTokens(args, 'CascadeType');
  const orphan = boolArg(args, 'orphanRemoval');
  const attrs = {
    field: f.name, fetch: fetchExplicit[0] || DEFAULT_FETCH[rel], fetch_default: fetchExplicit.length === 0,
    owning: mappedBy === null,
  };
  if (mappedBy) attrs.mapped_by = mappedBy;
  if (cascade.length) attrs.cascade = cascade;
  if (orphan !== null) attrs.orphan_removal = orphan;
  const join = f.annotation('JoinColumn');
  if (join) { attrs.join_column = strArg(join.argsText || '', 'name') || f.name; const r = strArg(join.argsText || '', 'referencedColumnName'); if (r) attrs.referenced_column = r; }
  const jt = f.annotation('JoinTable');
  if (jt) attrs.join_table = strArg(jt.argsText || '', 'name');
  return attrs;
}

export function apply(database, classes, symbols) {
  for (const ci of classes) {
    if (isEntity(ci)) {
      const columns = ci.fields.map(columnMapping);
      const attrs = { table: tableName(ci), columns };
      database.prepare('UPDATE nodes SET layer=?, signature=?, attrs=? WHERE id=?')
        .run('entity', `table=${attrs.table}`, JSON.stringify(attrs), ci.id);
      ci.fields.forEach((f, i) => db.setNodeAttrs(database, `${ci.id}.${f.name}`, JSON.stringify(columns[i])));
      for (const f of ci.fields) {
        const relName = f.annotations.find((a) => RELATION_ANNS[a.name]);
        if (!relName) continue;
        const rel = RELATION_ANNS[relName.name];
        let targetSimple = f.typeSimple;
        if (COLLECTION_RELATIONS.has(rel) && f.typeRaw && f.typeRaw.includes('<')) targetSimple = genericFirst(f.typeRaw) || targetSimple;
        const t = symbols.resolve(targetSimple, ci);
        if (t && t !== ci.id) db.addEdge(database, ci.id, t, rel, JSON.stringify(relationAttrs(f, rel)));
      }
    }
    const entitySimple = repositoryEntity(ci);
    if (entitySimple) {
      database.prepare("UPDATE nodes SET layer='repository' WHERE id=?").run(ci.id);
      const t = symbols.resolve(entitySimple, ci);
      if (t) db.addEdge(database, ci.id, t, 'persists');
    }
  }
}
