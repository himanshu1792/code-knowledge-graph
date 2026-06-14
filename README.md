# code-kg — a code knowledge graph for agents (Node.js)

Pre-compute an accurate, queryable knowledge graph of a **Java/Spring Boot +
Hibernate/JPA backend and a React frontend** — across multiple microservices —
then serve it to coding agents over **MCP** so they stop guessing which files to
change and can trace request/data flow across the whole ecosystem.

The graph is built **deterministically** with tree-sitter (Java + TSX grammars)
plus annotation/AST passes, stored in local **SQLite** (`node:sqlite`, no native
DB), and served via the official **MCP SDK**. An optional LLM enrichment pass
(**Azure OpenAI**) adds a feature→files map and one-line summaries — constrained
so it can only reference symbols that already exist (no hallucinated files).

```
index source ─▶ [1] Extractor (tree-sitter: Java + React/TSX) ─▶ SQLite (nodes/edges)
                [2] Spring pass        (endpoints, DI, layers)
                [2b] JPA/Hibernate pass (entities, mapping, repos)
                [2c] Outbound pass      (Feign/RestTemplate + React fetch/axios)
                [3] Enrichment (Azure OpenAI, optional) (features, summaries)
                [4] MCP server  ◀── agents query (kg_* tools)
                [5] federate    (merge services + link frontend↔backend)
```

## Requirements

- **Node.js ≥ 22** (uses the built-in `node:sqlite`).
- `npm install` (deps: `tree-sitter` + `tree-sitter-java` + `tree-sitter-typescript`,
  `@modelcontextprotocol/sdk`, `zod`, `openai`).

```bash
npm install
```

## How to run

The CLI is `node src/cli.js <command>` (or wire up the `code-kg` bin via
`npm link`). Commands: `index | reindex | enrich | serve | digest | federate`.

### Single service

```bash
# Index a backend service (point at the repo root or its source dir)
node src/cli.js index /path/to/order-service --service order-service
#   → writes /path/to/order-service/.code-kg/graph.db  (gitignored)

# Serve it to agents over MCP
node src/cli.js serve --repo /path/to/order-service

# Re-index after edits (incremental; detects changed files)
node src/cli.js reindex --repo /path/to/order-service

# Human-readable digest
node src/cli.js digest --repo /path/to/order-service -o ARCHITECTURE.md
```

### Multiple services + a React frontend (federated)

Index each service/app independently (order-independent), then **federate** to
link them — one MCP then exposes every service plus the cross-tier links.

```bash
node src/cli.js index /path/to/web-ui        --service web-ui
node src/cli.js index /path/to/user-service  --service user-service
node src/cli.js index /path/to/login-service --service login-service

node src/cli.js federate /path/to/web-ui /path/to/user-service /path/to/login-service -o federated.db

node src/cli.js serve --db federated.db      # one MCP, all of frontend + backends
```

### Optional LLM enrichment (Azure OpenAI)

```bash
export AZURE_OPENAI_API_KEY=...
export AZURE_OPENAI_ENDPOINT=https://<resource>.openai.azure.com
export AZURE_OPENAI_DEPLOYMENT=<chat-deployment>   # e.g. gpt-4o-mini
node src/cli.js enrich --repo /path/to/service     # or --db federated.db
```

## MCP tools

| Tool | What it answers |
|---|---|
| `kg_architecture()` | Layered overview: counts, layers, endpoints |
| `kg_find_files_for_feature(query)` | Files + entry points for a capability |
| `kg_endpoints()` / `kg_endpoint(path)` | Endpoints + downstream chain |
| `kg_callers(symbol)` / `kg_callees(symbol)` | Direct call edges |
| `kg_impact_of(symbol)` | What depends on a symbol (reverse reachability, cross-service) |
| `kg_data_model()` / `kg_entity(name)` | JPA/Hibernate entities, tables, relationship mapping |
| `kg_service_map()` | Service→service dependency map (frontend + backends) |
| `kg_request_flow(path)` | Trace a request through the call chain, across services |
| `kg_neighbors(node)` / `kg_describe(node)` | Node neighborhood / full detail |

Register the server with your agent via `mcp.user.json` (fill in absolute paths),
and drop `instructions/knowledge-graph-usage.instructions.md` into the agent's
instructions so it queries `kg_*` before guessing.

## What each pass extracts

- **Java/Spring**: classes/methods/fields; `calls`/`imports`/`extends`/`implements`
  edges; endpoints (`@GetMapping` + class `@RequestMapping` prefix → `routes_to`);
  DI (`injects`, constructor + `@Autowired`); layer classification.
- **JPA/Hibernate**: `@Entity` + table; relationship edges
  (`@OneToMany`/`@ManyToOne`/`@OneToOne`/`@ManyToMany`) with `cascade`/`fetch`/
  `mappedBy`/owning side/`@JoinColumn`/`@JoinTable`; `JpaRepository<T,ID>` →
  `persists` edge to the managed entity; per-column mapping (`@Id`,
  `@GeneratedValue`, `@Column` constraints) in node `attrs`.
- **React**: `component` nodes (function/arrow/class), `module` nodes, `uses_hook`
  edges (`useState`/`useEffect`/custom `use*`), `renders` edges (JSX usage), and
  **`fetch`/`axios` calls → `calls_service`** edges so the frontend links to
  backend endpoints.
- **Outbound (cross-service)**: backend OpenFeign + RestTemplate, frontend
  fetch/axios. Each is a `calls_service` edge with `{target_service, method, path}`.

## Federation

`federate` merges per-service graphs — node ids namespaced `<service>::…` so they
never collide — and matches each outbound `calls_service` call to the called
service's real endpoint handler, linking them with a `calls_remote` edge:

- Backend→backend: a Feign `name` / RestTemplate host must equal the called
  service's `--service` name.
- **Frontend→backend**: a React `fetch('/api/...')` uses a relative URL, so it
  matches **any** backend endpoint by HTTP method + path.

Indexing order does not matter; re-run `federate` after re-indexing any service.
`kg_impact_of` and `kg_request_flow` traverse `calls_remote`, so impact and
request flow span both service boundaries and the frontend↔backend boundary.

## Schema

```
nodes(id, kind, name, file, package, signature, start_line, end_line,
      annotations, layer, http_method, path, summary, attrs, service)
edges(src, dst, kind, attrs)
  -- kind: calls|imports|extends|implements|injects|routes_to|persists
  --       |one_to_many|many_to_one|one_to_one|many_to_many
  --       |calls_service|calls_remote|renders|uses_hook
features(id, name, description)
feature_files(feature_id, file, entry_node_id)
```

## Sync on remote pushes

A watcher only sees local edits. For repos updated by remote pushes (ADO/GitHub),
run a cron job that periodically `git pull`s, runs `reindex` per service, and
re-runs `federate`, rebuilding the merged graph in place.

## Development

```bash
npm test          # node --test, against the bundled Java + React fixtures
```

## Future enhancements (roadmap)

Designed-for but not yet built — the `nodes`/`edges`+`attrs` schema and `kg_*`
MCP boundary are meant to absorb these without a redesign.

- **GraphRAG / semantic discovery.** Embeddings index over node summaries +
  code, with a hybrid retriever (semantic seed → graph-edge expansion) exposed as
  `kg_search` / `kg_ask`. Highest value: fuzzy "where is X" lookup.
- **Wider coverage.** WebClient and message-driven flows (`@KafkaListener` /
  producers) on the backend; react-router / Next.js routes and prop/context data
  flow on the frontend.
- **Compiler-accurate call graph** (e.g. scip-java) backing `kg_impact_of`.
- **Per-method summaries**, polyglot support, optional Neo4j/FalkorDB backend.
