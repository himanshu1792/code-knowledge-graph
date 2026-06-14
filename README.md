# code-kg — a code knowledge graph for agents

Pre-compute an accurate, queryable knowledge graph of a Java/Spring codebase
**once**, then let coding agents query it at task start instead of guessing which
files to change.

The graph is built **deterministically** (tree-sitter for structure + a Spring
annotation pass for endpoints/DI/layers), stored in local **SQLite**, and served
to agents over **MCP**. An optional LLM enrichment pass adds summaries and a
feature→files map — constrained so it can only reference symbols that already
exist in the graph (no hallucinated files).

```
index source ──▶ [1] Extractor (tree-sitter)  ──▶ SQLite (nodes/edges)
                 [2] Spring pass (annotations) ──▶ SQLite (endpoints, DI, layers)
                 [3] Enrichment (LLM, optional) ─▶ SQLite (summaries, features)
                 [4] MCP server  ◀── agents query (kg_* tools)
                 [5] Sync: reindex command
```

## Install

Requires Python ≥ 3.11 and [`uv`](https://docs.astral.sh/uv/).

```bash
uv sync
```

Dependencies: `tree-sitter`, `tree-sitter-java`, `mcp[cli]` (FastMCP), `openai`
(Azure OpenAI client, used only by the optional `enrich` pass).

## Usage

```bash
# 1. Build the graph for a target repo (point at its Java source root)
uv run code-kg index /path/to/target/repo/src/main/java
#    → writes <repo>/.code-kg/graph.db  (gitignored, rebuilt on demand)

# 2. (optional) LLM enrichment via Azure OpenAI: feature→files map + summaries
export AZURE_OPENAI_API_KEY=...                       # Azure OpenAI key
export AZURE_OPENAI_ENDPOINT=https://<res>.openai.azure.com
export AZURE_OPENAI_DEPLOYMENT=<chat-deployment-name> # e.g. gpt-4o-mini
uv run code-kg enrich --repo /path/to/target/repo

# 3. Serve the graph to agents over MCP
uv run code-kg serve --repo /path/to/target/repo

# 4. Re-index after edits (incremental: detects changed files)
uv run code-kg reindex --repo /path/to/target/repo

# 5. Human-readable digest
uv run code-kg digest --repo /path/to/target/repo -o ARCHITECTURE.md
```

## MCP tools (the payoff)

| Tool | What it answers |
|---|---|
| `kg_architecture()` | Layered overview: counts, layers, endpoints |
| `kg_find_files_for_feature(query)` | Files + entry methods for a capability (kills file-guessing) |
| `kg_endpoints()` / `kg_endpoint(path)` | Endpoints from code + downstream chain |
| `kg_callers(symbol)` / `kg_callees(symbol)` | Direct call edges |
| `kg_impact_of(symbol)` | Everything that depends on a symbol (reverse reachability) |
| `kg_data_model()` | JPA/Hibernate entities, tables, relationships (cascade/fetch/owning), repository→entity |
| `kg_entity(name)` | Full mapping of one entity: columns, PK, relationships, repositories |
| `kg_neighbors(node)` / `kg_describe(node)` | Node neighborhood / full detail |
| `kg_service_map()` | Service→service dependency map (federated graph) |
| `kg_request_flow(path)` | Trace a request through the call chain, across services |

Register the server with your agent using `mcp.user.json` (fill in the absolute
paths). Drop `instructions/knowledge-graph-usage.instructions.md` into the
agent's instructions so it queries `kg_*` before guessing.

## Schema

```
nodes(id, kind, name, file, package, signature, start_line, end_line,
      annotations, layer, http_method, path, summary)
edges(src, dst, kind)        -- calls|imports|extends|implements|injects|routes_to
features(id, name, description)
feature_files(feature_id, file, entry_node_id)
```

## What the Spring pass adds over generic extraction

- **Endpoints**: `@GetMapping`/`@PostMapping`/… concatenated with class-level
  `@RequestMapping` prefix → resolved handler method + `routes_to` edge
  (e.g. class `/api/orders` + method `/sorted` ⇒ `GET /api/orders/sorted`).
- **DI edges**: constructor-injected params and `@Autowired` fields → `injects`.
- **Layer**: controller / service / repository / config / dao / model / util / entity.

## JPA / Hibernate awareness

On top of the Spring pass, the persistence layer is modeled (`code_kg/jpa.py`):

- **Entities**: `@Entity`/`@Table` classes → layer `entity`, with the table name.
  Each column carries its mapping in `attrs` (JSON): primary key (`@Id`),
  generation strategy (`@GeneratedValue`), and `@Column` constraints
  (name/nullable/unique/length), plus `@Lob`/`@Enumerated`/`@Version`/`@Transient`.
- **Relationships**: `@OneToMany`/`@ManyToOne`/`@OneToOne`/`@ManyToMany` fields →
  edges between entities (collection element type resolved from generics, e.g.
  `List<Purchase>` → `Purchase`). The edge `attrs` capture **how** they map:
  `cascade`, `fetch` (explicit or JPA default), `mappedBy`, owning vs inverse
  side, `orphanRemoval`, `@JoinColumn`, and `@JoinTable`.
- **Spring Data repositories**: interfaces extending `JpaRepository<T, ID>`
  (and `CrudRepository`, `PagingAndSortingRepository`, …) → layer `repository`
  plus a `persists` edge to the managed entity `T`.

Query it with `kg_data_model()` (overview) or `kg_entity(name)` (full mapping of
one entity). `kg_impact_of` also traverses persistence + relationship edges, so
changing an entity surfaces its repositories and the services that use them.

## Multiple microservices (cross-service flow)

Index each service independently, then **federate** to link them so an agent can
trace a request/data flow across services from a single MCP.

```bash
# 1. Index each service (order-independent), naming each one
uv run code-kg index /path/to/login-service/src/main/java --service login-service
uv run code-kg index /path/to/user-service/src/main/java  --service user-service

# 2. Merge + link cross-service calls into one graph
uv run code-kg federate /path/to/login-service /path/to/user-service -o federated.db

# 3. Serve the federated graph (one MCP exposes ALL services + the links)
uv run code-kg serve --db federated.db
```

- **Outbound calls** are detected per service: OpenFeign (`@FeignClient(name=…)`
  interfaces) and `RestTemplate` (`getForObject`/`postForObject`/… to
  `http://<service>/<path>`). Each is recorded as a `calls_service` edge.
- **`federate`** namespaces every node by service (`<service>::…`) so ids never
  collide, then matches each outbound call to the called service's real endpoint
  handler and links them with a `calls_remote` edge. Indexing order does not
  matter; re-run `federate` after re-indexing any service.
- **Contract:** a Feign `name` / RestTemplate host must equal the called
  service's `--service` name. Unmatched calls stay visible as *unresolved* in
  `kg_service_map()`.
- `kg_impact_of` and `kg_request_flow` traverse `calls_remote`, so impact and
  request flow span service boundaries.

## Sync on remote pushes

A watcher only sees local edits. For repos updated by remote pushes, run a cron
job that periodically `git pull`s and runs `code-kg reindex`, rebuilding
`graph.db` in place.

## Scope / non-goals (this phase)

Java/Spring Boot first. Polyglot support, graph-DB backends (Neo4j/FalkorDB), and
GraphRAG/embeddings are deferred — the SQLite schema + MCP boundary are designed
so those can be added later without changing the `kg_*` interface.

## Development

```bash
uv run pytest          # runs tests against the bundled Java fixture
```
