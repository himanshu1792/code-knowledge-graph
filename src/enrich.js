// Optional LLM enrichment via Azure OpenAI: feature->files map + per-node
// one-line summaries. Hard anti-hallucination gate: only references to nodes/files
// already in the graph are written; everything else is rejected.
import * as db from './db.js';

export const DEFAULT_API_VERSION = '2024-10-21';
export const DEFAULT_DEPLOYMENT = 'gpt-4o-mini';

export class EnrichmentRejected extends Error {}

export function writeSummary(database, nodeId, summary) {
  if (!db.nodeIds(database).has(nodeId)) throw new EnrichmentRejected(`unknown node id: ${nodeId}`);
  database.prepare('UPDATE nodes SET summary = ? WHERE id = ?').run(summary, nodeId);
}

export function writeFeature(database, fid, name, description, fileList, entryNodes = {}) {
  const knownFiles = db.files(database);
  const knownNodes = db.nodeIds(database);
  for (const f of fileList) if (!knownFiles.has(f)) throw new EnrichmentRejected(`unknown file: ${f}`);
  for (const nid of Object.values(entryNodes)) if (nid && !knownNodes.has(nid)) throw new EnrichmentRejected(`unknown entry node: ${nid}`);
  database.prepare('INSERT OR REPLACE INTO features (id, name, description) VALUES (?,?,?)').run(fid, name, description);
  for (const f of fileList) {
    database.prepare('INSERT OR IGNORE INTO feature_files (feature_id, file, entry_node_id) VALUES (?,?,?)')
      .run(fid, f, entryNodes[f] || null);
  }
}

function contextPayload(database) {
  const classes = database.prepare(
    "SELECT id, name, file, layer FROM nodes WHERE kind IN ('class','interface','enum','component') ORDER BY file",
  ).all();
  const endpoints = database.prepare(
    "SELECT http_method, path, id FROM nodes WHERE http_method IS NOT NULL AND kind != 'external_endpoint' ORDER BY path",
  ).all();
  return {
    classes: classes.map((r) => ({ id: r.id, name: r.name, file: r.file, layer: r.layer })),
    endpoints: endpoints.map((r) => ({ method: r.http_method, path: r.path, node_id: r.id })),
  };
}

const SYSTEM = (
  'You enrich a code knowledge graph for a Java/Spring + React codebase. '
  + 'You are given the EXACT set of classes/components (with file paths and node ids) and '
  + 'HTTP endpoints already extracted deterministically. You must ONLY reference files and '
  + 'node ids from that set — never invent names. Do two things: '
  + '(1) group the codebase into user-facing features/capabilities, listing the files for each '
  + '(and an entry node id where applicable); (2) write a concise one-line summary for each '
  + 'class/component/endpoint node id. Respond with a single JSON object: '
  + '{"features":[{"name":str,"description":str,"files":[str],"entry_node_id":str?}],'
  + '"summaries":[{"node_id":str,"summary":str}]}.'
);

export async function enrich(database, opts = {}) {
  const { AzureOpenAI } = await import('openai');
  const apiKey = opts.apiKey || process.env.AZURE_OPENAI_API_KEY;
  const endpoint = opts.endpoint || process.env.AZURE_OPENAI_ENDPOINT;
  const deployment = opts.deployment || process.env.AZURE_OPENAI_DEPLOYMENT || DEFAULT_DEPLOYMENT;
  const apiVersion = opts.apiVersion || process.env.AZURE_OPENAI_API_VERSION || DEFAULT_API_VERSION;
  if (!apiKey || !endpoint) {
    throw new Error('Azure OpenAI not configured; set AZURE_OPENAI_API_KEY and AZURE_OPENAI_ENDPOINT (and AZURE_OPENAI_DEPLOYMENT)');
  }
  const client = new AzureOpenAI({ apiKey, endpoint, apiVersion, deployment });
  const payload = contextPayload(database);
  const resp = await client.chat.completions.create({
    model: deployment,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `Ground-truth graph context as JSON:\n\n${JSON.stringify(payload, null, 2)}` },
    ],
  });
  const data = JSON.parse(resp.choices[0].message.content || '{}');

  let featW = 0; let featR = 0; let sumW = 0; let sumR = 0;
  database.exec("DELETE FROM feature_files WHERE feature_id LIKE 'llm:%'");
  database.exec("DELETE FROM features WHERE id LIKE 'llm:%'");
  (data.features || []).forEach((feat, i) => {
    const entry = feat.entry_node_id;
    const entryNodes = entry ? Object.fromEntries((feat.files || []).map((f) => [f, entry])) : {};
    try { writeFeature(database, `llm:${i}`, feat.name || `llm:${i}`, feat.description || '', feat.files || [], entryNodes); featW += 1; } catch (e) { if (e instanceof EnrichmentRejected) featR += 1; else throw e; }
  });
  for (const item of data.summaries || []) {
    if (!item.node_id || !item.summary) continue;
    try { writeSummary(database, item.node_id, item.summary); sumW += 1; } catch (e) { if (e instanceof EnrichmentRejected) sumR += 1; else throw e; }
  }
  return { features_written: featW, features_rejected: featR, summaries_written: sumW, summaries_rejected: sumR };
}
