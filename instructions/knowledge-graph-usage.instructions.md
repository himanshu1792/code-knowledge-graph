---
applyTo: '**'
---

# Use the code knowledge graph before guessing

A pre-computed, accurate knowledge graph of this codebase is available through the
`code-kg` MCP server. It is built deterministically from the source (tree-sitter +
Spring annotations), so it does **not** hallucinate files or symbols.

**At the start of any task that touches this codebase, query the graph instead of
guessing which files to change.**

- Orienting on a new task → `kg_architecture()` for the layered overview.
- "Where is feature X / where do I add Y?" → `kg_find_files_for_feature("...")`.
  Returns the implementing files + entry methods. Do not grep blindly first.
- Working on an HTTP route → `kg_endpoints()` / `kg_endpoint("/api/...")` for the
  handler and its downstream call chain. (Trust the code-derived endpoints over
  any `swagger.json` — docs are often stale/incomplete.)
- Before changing a class/method → `kg_impact_of("OrderService")` to see what
  depends on it; `kg_callers(...)` / `kg_callees(...)` for direct call edges.
- Understanding a symbol → `kg_describe("...")`, `kg_neighbors("...")`.

The graph is the source of truth for structure (classes, endpoints, dependency
injection, call/impact relationships). Use it first; fall back to reading files
only for the specific lines you need to edit.
