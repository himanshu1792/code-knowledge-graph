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

Dependencies: `tree-sitter`, `tree-sitter-java`, `mcp[cli]` (FastMCP), `anthropic`.

## Usage

```bash
# 1. Build the graph for a target repo (point at its Java source root)
uv run code-kg index /path/to/target/repo/src/main/java
#    → writes <repo>/.code-kg/graph.db  (gitignored, rebuilt on demand)

# 2. (optional) LLM enrichment: per-class summaries + feature→files map
ANTHROPIC_API_KEY=sk-... uv run code-kg enrich --repo /path/to/target/repo

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
