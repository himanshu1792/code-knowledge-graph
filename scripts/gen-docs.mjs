// Generate docs/code-kg-overview.{pptx,docx} (Node, no Python).
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pptxgen from 'pptxgenjs';
import {
  Document, Packer, Paragraph, HeadingLevel, TextRun,
} from 'docx';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs');
const ACCENT = '2E6F9E';

// ---------------- PPTX ----------------
const pptx = new pptxgen();
pptx.defineLayout({ name: 'W', width: 13.33, height: 7.5 });
pptx.layout = 'W';

function slide(title, lines) {
  const s = pptx.addSlide();
  s.addText(title, { x: 0.6, y: 0.35, w: 12, h: 0.8, fontSize: 28, bold: true, color: '1F3355' });
  s.addText(
    lines.map((l) => ({
      text: l.t,
      options: { bullet: l.lvl !== undefined, indentLevel: l.lvl || 0, fontSize: l.sz || 16, bold: !!l.b, color: l.c || '333333', breakLine: true },
    })),
    { x: 0.7, y: 1.5, w: 12, h: 5.6, valign: 'top' },
  );
}

slide('Code Knowledge Graph for Agents (code-kg) — Node.js', [
  { t: 'The problem', sz: 20, b: true, c: ACCENT },
  { t: 'AI coding agents rebuild their mental model on every task, guess which files to change, and make mistakes.', lvl: 1 },
  { t: 'The solution', sz: 20, b: true, c: ACCENT },
  { t: 'Pre-compute an accurate, queryable knowledge graph ONCE; agents query it at task start instead of guessing.', lvl: 1 },
  { t: 'Deterministic build (tree-sitter: Java + React/TSX) -> local SQLite (node:sqlite) -> served over MCP.', lvl: 1 },
  { t: 'Optional LLM enrichment (Azure OpenAI): feature->files map + per-node summaries, gated to real symbols.', lvl: 1 },
  { t: 'Scope: Java / Spring Boot / Hibernate (JPA) backends + React frontends, federated across microservices.', lvl: 1, b: true },
]);

slide('Architecture & Pipeline', [
  { t: '[1] Extractor (tree-sitter Java + TSX) -> nodes + edges; React adds components, hooks, renders, routes, context, props', lvl: 0 },
  { t: '[2] Spring pass -> endpoints (@GetMapping + @RequestMapping prefix), DI injects, layers', lvl: 0 },
  { t: '[2b] JPA/Hibernate -> @Entity + table, relationships (cascade/fetch/mappedBy/owning/@JoinColumn), repos', lvl: 0 },
  { t: '[2c] Outbound -> backend Feign/RestTemplate + React fetch/axios -> calls_service', lvl: 0 },
  { t: '[3] Enrichment (Azure OpenAI, optional) -> features + summaries; anti-hallucination gate', lvl: 0 },
  { t: '[4] MCP server -> agents query via kg_* tools', lvl: 0 },
  { t: '[5] federate -> merge services + link frontend<->backend (calls_remote)', lvl: 0 },
  { t: 'Storage: one local SQLite file at .code-kg/graph.db (gitignored, rebuilt on demand)', lvl: 0, b: true, c: ACCENT },
]);

slide('Capabilities, Usage & Stack', [
  { t: 'MCP tools', sz: 18, b: true, c: ACCENT },
  { t: 'kg_architecture | kg_find_files_for_feature | kg_endpoints/kg_endpoint | kg_callers/kg_callees | kg_impact_of | kg_data_model/kg_entity | kg_service_map/kg_request_flow | kg_neighbors/kg_describe', lvl: 1 },
  { t: 'CLI (Node)', sz: 18, b: true, c: ACCENT },
  { t: 'node src/cli.js  index | reindex | enrich | serve | digest | federate', lvl: 1 },
  { t: 'Differentiators', sz: 18, b: true, c: ACCENT },
  { t: 'Spring DI edges, deep JPA/Hibernate mapping, React component/hook/render model, and full-stack request flow.', lvl: 1 },
  { t: 'Tech stack', sz: 18, b: true, c: ACCENT },
  { t: 'Node.js 22 (node:sqlite) | tree-sitter (java + typescript) | MCP SDK | Azure OpenAI (optional)', lvl: 1 },
]);

slide('Full-Stack & Microservices: Federation', [
  { t: 'Index each service/app independently (order-independent), then federate to link them.', sz: 17, b: true },
  { t: 'Backend outbound: OpenFeign (@FeignClient) and RestTemplate (http://<service>/<path>).', lvl: 0 },
  { t: 'Frontend outbound: React fetch(\'/api/..\') / axios.get(\'/api/..\') -> calls_service.', lvl: 0 },
  { t: 'federate namespaces nodes <service>:: and matches each outbound call to the real backend endpoint -> calls_remote.', lvl: 0 },
  { t: 'Frontend relative URLs match any backend by method + path (full-stack request flow).', lvl: 0 },
  { t: 'One federated MCP exposes ALL frontends + backends plus the cross-tier links.', lvl: 0, b: true, c: ACCENT },
  { t: 'kg_service_map() = who calls whom; kg_request_flow() traces a request across frontend and backends.', lvl: 0 },
]);

await pptx.writeFile({ fileName: join(OUT, 'code-kg-overview.pptx') });

// ---------------- DOCX ----------------
const H = (text, level) => new Paragraph({ text, heading: level });
const P = (text, bold = false) => new Paragraph({ children: [new TextRun({ text, bold })] });
const LI = (text) => new Paragraph({ text, bullet: { level: 0 } });

const children = [
  new Paragraph({ text: 'Code Knowledge Graph for Agents (code-kg) — Node.js', heading: HeadingLevel.TITLE }),
  P('A pre-computed, queryable knowledge graph of Java/Spring Boot + Hibernate/JPA backends and React frontends, across microservices, served to AI coding agents over MCP so they can locate files and understand request/data flow at task start.'),

  H('1. Problem & Solution', HeadingLevel.HEADING_1),
  P('Problem', true),
  LI('Coding agents rebuild their mental model on every task, guess which files to change, and make mistakes.'),
  P('Solution', true),
  LI('Pre-compute an accurate, queryable knowledge graph once; the agent queries it at the start of each task.'),
  LI('Built deterministically with tree-sitter (Java + React/TSX) plus annotation/AST passes, stored in local SQLite (node:sqlite), served over MCP.'),
  LI('Optional LLM enrichment (Azure OpenAI) adds a feature->files map and per-node summaries, validated against the live graph (anti-hallucination gate).'),
  LI('Scope: Java, Spring Boot, Hibernate/JPA, React, and full-stack/cross-service flow via federation.'),

  H('2. Architecture & Pipeline', HeadingLevel.HEADING_1),
  LI('[1] Extractor (tree-sitter Java + TSX): nodes (class/method/field; React component/hook/module/route/context) and edges (calls/imports/extends/implements; React renders/passes_prop/uses_hook/uses_context/provides_context/routes_to).'),
  LI('[2] Spring pass: endpoints (mapping + @RequestMapping prefix), DI injects, layers.'),
  LI('[2b] JPA/Hibernate: @Entity + table, relationships with cascade/fetch/mappedBy/owning/@JoinColumn, JpaRepository -> entity (persists), per-column mapping.'),
  LI('[2c] Outbound: backend Feign/RestTemplate and React fetch/axios, recorded as calls_service edges.'),
  LI('[3] Enrichment (optional, Azure OpenAI): features + summaries, anti-hallucination gated.'),
  LI('[4] MCP server: agents query via kg_* tools.'),
  LI('[5] federate: merge services and link frontend<->backend with calls_remote.'),
  P('Storage: one local SQLite file at .code-kg/graph.db (gitignored, rebuilt on demand). Schema: nodes (with JSON attrs + service), edges (src,dst,kind,attrs), features, feature_files.'),

  H('3. Capabilities, Usage & Stack', HeadingLevel.HEADING_1),
  P('MCP tools', true),
  LI('kg_architecture, kg_find_files_for_feature, kg_endpoints/kg_endpoint, kg_callers/kg_callees, kg_impact_of.'),
  LI('kg_data_model/kg_entity (JPA), kg_service_map/kg_request_flow (cross-service/full-stack), kg_neighbors/kg_describe.'),
  P('CLI (Node)', true),
  LI('node src/cli.js index | reindex | enrich | serve | digest | federate'),
  P('Tech stack', true),
  LI('Node.js 22 (built-in node:sqlite), tree-sitter (java + typescript), MCP SDK, zod, Azure OpenAI (optional).'),

  H('4. Full-Stack & Microservices: Federation', HeadingLevel.HEADING_1),
  LI('Index each backend service and each React frontend independently (order does not matter), naming each with --service.'),
  LI('Backend outbound calls: OpenFeign (@FeignClient name) and RestTemplate (http://<service>/<path>). Frontend outbound: fetch / axios.'),
  LI('federate namespaces nodes <service>:: and matches each outbound call to the called service\'s real endpoint, linking with a calls_remote edge.'),
  LI('Frontend relative URLs (fetch(\'/api/..\')) match any backend endpoint by HTTP method + path, giving full-stack request flow.'),
  LI('One federated MCP exposes every frontend + backend plus the cross-tier links; kg_impact_of and kg_request_flow span the boundaries.'),
];

const doc = new Document({ sections: [{ children }] });
const buf = await Packer.toBuffer(doc);
writeFileSync(join(OUT, 'code-kg-overview.docx'), buf);
console.log('Generated docs/code-kg-overview.{pptx,docx}');
