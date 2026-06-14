// tree-sitter parser setup (native bindings) + small node helpers.
import Parser from 'tree-sitter';
import Java from 'tree-sitter-java';
import TS from 'tree-sitter-typescript';

let _java;
let _tsx;

export function javaParser() {
  if (!_java) { _java = new Parser(); _java.setLanguage(Java); }
  return _java;
}

export function tsxParser() {
  if (!_tsx) { _tsx = new Parser(); _tsx.setLanguage(TS.tsx); }
  return _tsx;
}

export const line = (node) => (node ? node.startPosition.row + 1 : 0);
export const endLine = (node) => (node ? node.endPosition.row + 1 : 0);

export function field(node, name) {
  return node ? node.childForFieldName(name) : null;
}

export function childrenOfType(node, type) {
  return node ? node.children.filter((c) => c.type === type) : [];
}

export function firstOfType(node, type) {
  return node ? node.children.find((c) => c.type === type) || null : null;
}

// Reduce a type expression to its simple name: List<Order> -> List; a.b.Foo -> Foo; Foo[] -> Foo
export function simpleTypeName(text) {
  if (!text) return null;
  let t = text.trim();
  const lt = t.indexOf('<');
  if (lt >= 0) t = t.slice(0, lt);
  t = t.replaceAll('[]', '').trim();
  const dot = t.lastIndexOf('.');
  if (dot >= 0) t = t.slice(dot + 1);
  return t;
}

export function annotationName(text) {
  let t = text.replace(/^@/, '').trim();
  const paren = t.indexOf('(');
  if (paren >= 0) t = t.slice(0, paren);
  const dot = t.lastIndexOf('.');
  if (dot >= 0) t = t.slice(dot + 1);
  return t.trim();
}
