// Deterministic Java extractor (the generic spine) + cross-file resolution.
// Parses Java into a rich model consumed by the Spring / JPA / outbound passes.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  javaParser, line, endLine, simpleTypeName, annotationName,
} from './parsers.js';
import * as db from './db.js';

const TYPE_DECLS = {
  class_declaration: 'class',
  interface_declaration: 'interface',
  enum_declaration: 'enum',
};

function annotationsOf(node) {
  const out = [];
  const kids = [...node.children];
  for (const ch of node.children) if (ch.type === 'modifiers') kids.push(...ch.children);
  for (const ch of kids) {
    if (ch.type === 'marker_annotation' || ch.type === 'annotation') {
      const nameNode = ch.childForFieldName('name');
      const name = annotationName(nameNode ? nameNode.text : ch.text);
      const argsNode = ch.childForFieldName('arguments');
      let args = argsNode ? argsNode.text : '';
      if (args.startsWith('(') && args.endsWith(')')) args = args.slice(1, -1);
      out.push({ name, argsText: args });
    }
  }
  return out;
}

const hasAnn = (info, ...names) => info.annotations.some((a) => names.includes(a.name));
const getAnn = (info, name) => info.annotations.find((a) => a.name === name) || null;

function typeNamesIn(node) {
  const out = [];
  for (const ch of node.children) {
    if (['type_identifier', 'scoped_type_identifier', 'generic_type'].includes(ch.type)) {
      out.push(simpleTypeName(ch.text));
    }
  }
  return out;
}
function rawTypesIn(node) {
  const out = [];
  for (const ch of node.children) {
    if (['type_identifier', 'scoped_type_identifier', 'generic_type'].includes(ch.type)) out.push(ch.text);
  }
  return out;
}

function methodNodeId(ownerId, m) {
  const sig = m.params.map(([, t]) => t || '?').join(',');
  return `${ownerId}#${m.name}(${sig})`;
}
function methodSignature(m) {
  const ps = m.params.map(([n, t]) => `${t || 'var'} ${n}`).join(', ');
  return `${m.returnType ? `${m.returnType} ` : ''}${m.name}(${ps})`;
}
const classId = (ci) => (ci.package ? `${ci.package}.${ci.name}` : ci.name);

function stringLiterals(argsNode) {
  if (!argsNode) return [];
  const out = [];
  for (const ch of argsNode.children) {
    if (ch.type === 'string_literal') {
      let t = ch.text;
      if (t.length >= 2 && '"\''.includes(t[0])) t = t.slice(1, -1);
      out.push(t);
    }
  }
  return out;
}

function scanBody(node, mi) {
  if (node.type === 'local_variable_declaration') {
    const typeNode = node.childForFieldName('type');
    const ts = typeNode ? simpleTypeName(typeNode.text) : null;
    for (const ch of node.children) {
      if (ch.type === 'variable_declarator') {
        const n = ch.childForFieldName('name');
        if (n && ts) mi.locals[n.text] = ts;
      }
    }
  } else if (node.type === 'method_invocation') {
    const nameNode = node.childForFieldName('name');
    const objNode = node.childForFieldName('object');
    let receiver = null;
    if (objNode) {
      if (objNode.type === 'identifier') receiver = objNode.text;
      else if (objNode.type === 'this') receiver = 'this';
    }
    if (nameNode) {
      mi.invocations.push({
        receiver, method: nameNode.text,
        strArgs: stringLiterals(node.childForFieldName('arguments')),
      });
    }
  }
  for (const ch of node.children) scanBody(ch, mi);
}

function parseMethod(node) {
  const isCtor = node.type === 'constructor_declaration';
  const nameNode = node.childForFieldName('name');
  const name = nameNode ? nameNode.text : '<init>';
  const retNode = node.childForFieldName('type');
  const returnType = retNode && !isCtor ? simpleTypeName(retNode.text) : null;
  const params = [];
  const pnode = node.childForFieldName('parameters');
  if (pnode) {
    for (const p of pnode.children) {
      if (p.type === 'formal_parameter' || p.type === 'spread_parameter') {
        const pt = p.childForFieldName('type');
        const pn = p.childForFieldName('name');
        params.push([pn ? pn.text : '?', pt ? simpleTypeName(pt.text) : null]);
      }
    }
  }
  const mi = {
    name, params, returnType, annotations: annotationsOf(node), isConstructor: isCtor,
    startLine: line(node), endLine: endLine(node), locals: {}, invocations: [],
  };
  const body = node.childForFieldName('body');
  if (body) scanBody(body, mi);
  return mi;
}

function parseField(node) {
  const anns = annotationsOf(node);
  const typeNode = node.childForFieldName('type');
  const typeSimple = typeNode ? simpleTypeName(typeNode.text) : null;
  const typeRaw = typeNode ? typeNode.text : null;
  const out = [];
  for (const ch of node.children) {
    if (ch.type === 'variable_declarator') {
      const n = ch.childForFieldName('name');
      if (n) {
        out.push({
          name: n.text, typeSimple, typeRaw, annotations: anns,
          annotation: (nm) => anns.find((a) => a.name === nm) || null,
          startLine: line(node), endLine: endLine(node),
        });
      }
    }
  }
  return out;
}

function parseType(node, pkg, rel, imports) {
  const nameNode = node.childForFieldName('name');
  const ci = {
    name: nameNode ? nameNode.text : '<anon>',
    package: pkg, file: rel, kind: TYPE_DECLS[node.type],
    annotations: annotationsOf(node), extends: [], implements: [], rawSupertypes: [],
    fields: [], methods: [], imports, startLine: line(node), endLine: endLine(node),
  };
  ci.id = classId(ci);
  ci.hasAnnotation = (...n) => hasAnn(ci, ...n);
  ci.annotation = (n) => getAnn(ci, n);

  for (const ch of node.children) {
    if (ch.type === 'superclass') {
      ci.extends.push(...typeNamesIn(ch)); ci.rawSupertypes.push(...rawTypesIn(ch));
    } else if (ch.type === 'super_interfaces') {
      for (const c of ch.children) if (c.type === 'type_list') {
        ci.implements.push(...typeNamesIn(c)); ci.rawSupertypes.push(...rawTypesIn(c));
      }
    } else if (ch.type === 'extends_interfaces') {
      for (const c of ch.children) if (c.type === 'type_list') {
        ci.extends.push(...typeNamesIn(c)); ci.rawSupertypes.push(...rawTypesIn(c));
      }
    }
  }
  const body = node.children.find((c) => ['class_body', 'interface_body', 'enum_body'].includes(c.type));
  if (body) {
    for (const m of body.children) {
      if (m.type === 'field_declaration') ci.fields.push(...parseField(m));
      else if (m.type === 'method_declaration' || m.type === 'constructor_declaration') ci.methods.push(parseMethod(m));
    }
  }
  return ci;
}

function walkTypes(node, pkg, rel, imports, out) {
  for (const ch of node.children) {
    if (TYPE_DECLS[ch.type]) {
      out.push(parseType(ch, pkg, rel, imports));
      const body = ch.children.find((c) => ['class_body', 'interface_body', 'enum_body'].includes(c.type));
      if (body) walkTypes(body, pkg, rel, imports, out);
    } else if (ch.type === 'program') {
      walkTypes(ch, pkg, rel, imports, out);
    }
  }
}

export function parseFile(absPath, rel) {
  const src = readFileSync(absPath, 'utf8');
  const tree = javaParser().parse(src);
  const root = tree.rootNode;
  let pkg = '';
  const imports = {};
  for (const ch of root.children) {
    if (ch.type === 'package_declaration') {
      for (const c of ch.children) if (['scoped_identifier', 'identifier'].includes(c.type)) pkg = c.text;
    } else if (ch.type === 'import_declaration') {
      let fqn = null;
      for (const c of ch.children) if (['scoped_identifier', 'identifier'].includes(c.type)) fqn = c.text;
      if (fqn && !fqn.endsWith('*')) imports[fqn.split('.').pop()] = fqn;
    }
  }
  const out = [];
  walkTypes(root, pkg, rel, imports, out);
  return out;
}

export function discoverJavaFiles(root) {
  const out = [];
  const skip = new Set(['.git', 'target', 'build', '.code-kg', 'node_modules']);
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (!skip.has(e.name)) walk(p); }
      else if (e.name.endsWith('.java') && !e.name.endsWith('package-info.java')) out.push(p);
    }
  };
  walk(root);
  return out.sort();
}

export class Symbols {
  constructor(classes) {
    this.byId = new Map();
    this.bySimple = new Map();
    for (const c of classes) {
      this.byId.set(c.id, c);
      if (!this.bySimple.has(c.name)) this.bySimple.set(c.name, []);
      this.bySimple.get(c.name).push(c.id);
    }
  }
  resolve(simple, ctx) {
    if (!simple) return null;
    if (ctx.imports[simple] && this.byId.has(ctx.imports[simple])) return ctx.imports[simple];
    const same = ctx.package ? `${ctx.package}.${simple}` : simple;
    if (this.byId.has(same)) return same;
    const cand = this.bySimple.get(simple);
    if (cand && cand.length === 1) return cand[0];
    return null;
  }
  methodsNamed(classId_, name) {
    const ci = this.byId.get(classId_);
    if (!ci) return [];
    return ci.methods.filter((m) => m.name === name).map((m) => methodNodeId(classId_, m));
  }
}

export function parseRepo(root) {
  const classes = [];
  for (const abs of discoverJavaFiles(root)) classes.push(...parseFile(abs, relative(root, abs)));
  return { classes, symbols: new Symbols(classes) };
}

export function writeStructure(database, classes, symbols) {
  for (const ci of classes) {
    db.upsertNode(database, {
      id: ci.id, kind: ci.kind, name: ci.name, file: ci.file, package: ci.package,
      start_line: ci.startLine, end_line: ci.endLine,
      annotations: ci.annotations.map((a) => a.name).join(',') || null,
    });
    for (const f of ci.fields) {
      db.upsertNode(database, {
        id: `${ci.id}.${f.name}`, kind: 'field', name: f.name, file: ci.file,
        package: ci.package, signature: f.typeSimple, start_line: f.startLine, end_line: f.endLine,
        annotations: f.annotations.map((a) => a.name).join(',') || null,
      });
    }
    for (const m of ci.methods) {
      db.upsertNode(database, {
        id: methodNodeId(ci.id, m), kind: 'method', name: m.name, file: ci.file,
        package: ci.package, signature: methodSignature(m), start_line: m.startLine, end_line: m.endLine,
        annotations: m.annotations.map((a) => a.name).join(',') || null,
      });
    }
  }
  for (const ci of classes) {
    for (const sup of ci.extends) { const t = symbols.resolve(sup, ci); if (t) db.addEdge(database, ci.id, t, 'extends'); }
    for (const itf of ci.implements) { const t = symbols.resolve(itf, ci); if (t) db.addEdge(database, ci.id, t, 'implements'); }
    for (const fqn of Object.values(ci.imports)) if (symbols.byId.has(fqn)) db.addEdge(database, ci.id, fqn, 'imports');
    writeCalls(database, ci, symbols);
  }
}

function writeCalls(database, ci, symbols) {
  for (const m of ci.methods) {
    const caller = methodNodeId(ci.id, m);
    const env = {};
    for (const f of ci.fields) if (f.typeSimple) env[f.name] = f.typeSimple;
    for (const [pn, pt] of m.params) if (pt) env[pn] = pt;
    Object.assign(env, m.locals);
    for (const inv of m.invocations) {
      let targetSimple;
      if (inv.receiver === null || inv.receiver === 'this') targetSimple = ci.name;
      else if (env[inv.receiver]) targetSimple = env[inv.receiver];
      else targetSimple = inv.receiver;
      const targetId = symbols.resolve(targetSimple, ci);
      if (!targetId) continue;
      const mids = symbols.methodsNamed(targetId, inv.method);
      if (mids.length) for (const mid of mids) db.addEdge(database, caller, mid, 'calls');
      else db.addEdge(database, caller, targetId, 'calls');
    }
  }
}

export { methodNodeId, classId };
