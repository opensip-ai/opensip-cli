---
status: active
last_verified: 2026-06-27
owner: opensip-cli
---

# ADR-0084: MCP Server Surface for Graph and OpenSIP Results

```yaml
id: ADR-0084
title: MCP Server Surface for Graph and OpenSIP Results
date: 2026-06-27
status: active
supersedes: []
superseded_by: null
related: [ADR-0009, ADR-0006, ADR-0030]
tags: [mcp, graph, agents, tools, packaging]
enforcement: mechanizable
enforcement-reason: >
  The result-tools-never-rerun invariant is enforced by the new
  `mcp-results-no-rerun` fitness check; the no-SessionRepo / no-raw-db invariants
  by the existing `architecture-session-timing-not-host-owned` /
  `restrict-raw-db-access` self-checks (which auto-govern `packages/mcp/` once it
  joins `bundledPackages`); the no-`mcp→cli` edge and the scoped `graph/internal`
  exception by dependency-cruiser. See the Fitness check section.
```

**Decision:** Ship a bundled first-party tool package `@opensip-cli/mcp` that
adds one long-lived, blocking command — `opensip mcp` — which serves the existing
persisted call graph and stored OpenSIP run results to MCP-capable coding agents
over **stdio JSON-RPC**. The surface is **read-only** except for one explicit
state-changing op, `refresh_graph`. Handlers depend on two narrow ports
(`GraphReadPort`, `ResultsReadPort`) for SaaS parity, never on `CatalogRepo` /
`SessionRepo` / CLI command files. Every graph query carries `{ data, freshness }`
— a stale or missing catalog is served **with a warning**, never silently; a
missing catalog requires an explicit `refresh_graph` (**no auto-build on
startup**). Result/history tools **replay persisted sessions only** — they never
re-run `fit`/`graph`/`sim`/`yagni`.

**Alternatives:**

- **HTTP/SSE transport instead of stdio** — rejected; an agent spawns the server
  as a child process and owns its lifetime, so stdio JSON-RPC needs no port, no
  listener, and no auth layer. A network transport would add a trust surface this
  feature does not need.
- **Auto-build the catalog on startup / on a missing-catalog query** — rejected;
  a silent full graph build inside an agent query is a surprising, expensive side
  effect. Freshness is surfaced as data and the agent decides when to
  `refresh_graph` (an explicit, cost-warned op).
- **Result tools that re-run the underlying tool when no session exists** —
  rejected; the product contract is *result-first* (replay the stored result,
  steer the agent away from re-running). Re-running would defeat the token-saving
  premise and is forbidden by `mcp-results-no-rerun`.
- **Reach `CatalogRepo`/`SessionRepo` directly from handlers** — rejected; ports
  give a test seam (handlers unit-test against in-memory fakes) and a compile-time
  SaaS-parity boundary (a cloud backend can substitute behind the same interface).
- **A new MCP-owned `graph_catalog` table / raw `DataStore.db` reads** — rejected;
  MCP reads the graph tool's own derived-data catalog via `CatalogRepo` (ADR-0006)
  and sessions via the session-store read API. No parallel persistence.

**Rationale:** opensip-cli already builds and persists a rich call graph
(`runGraph` → `graph_catalog` row → `CatalogRepo` + `Indexes`) and stores tool
sessions with efficient replay (`sessions show latest --tool fit --json
--filter …`), but nothing exposes either to an external coding agent (greenfield:
zero `@modelcontextprotocol` references today). An MCP server lets an agent ask
structural questions (`who_calls`, `blast_radius`, `trace_path`) instead of
reading files, and result questions (`get_latest_findings`, `show_run`) instead
of re-running tools when a prior result already exists. Reusing graph's
traversal/scoring/freshness (`buildIndexes`, `computeBlast`, `classifyCatalog`)
keeps MCP's answers identical to `opensip graph` and avoids a parallel engine.

**ADR-0009 exception:** `@opensip-cli/mcp` may import
`@opensip-cli/graph/internal` (read-only, in-monorepo) — `internal.ts`'s header
otherwise forbids non-test production imports of another package's internal
surface. The exception is **MCP-only** and **scoped to `internal.ts`** (never
`cache/invalidate.ts`, `pipeline/*`, etc.), enforced narrowly by the
dependency-cruiser `no-cross-package-internal` rule. The freshness helpers
(`classifyCatalog`, `computeFilesFingerprint`) are surfaced on that internal
contract for MCP to consume.

**Consequences:**

- A new `RawStreamReason` member `mcp-stdio` is added (`command-spec.ts`): the
  `mcp` command sets `output: 'raw-stream'` + `rawStreamReason: 'mcp-stdio'`
  because JSON-RPC owns stdout for the protocol; all logging/diagnostics go to
  **stderr** for the serve lifetime. This is the documented escape hatch from the
  `SignalEnvelope`/`CommandResult` currency, recorded in `raw-stream-parity`.
- `@opensip-cli/mcp` is added to `bundledPackages` (5th bundled tool) and to
  the publish order (after the `graph-*` adapters, before `cli`). It declares a
  capability domain `mcp-graph-adapter` (distinct id, first-writer-wins) with
  `markerKind: 'graph-adapter'`, so the bundled `graph-*` adapter packs load under
  MCP's domain.
- **Capability-loader routing (as-built).** Sharing the `graph-adapter`
  markerKind across two domains required one host change: a *primary* capability
  contribution now routes to the **target domain it declares**
  (`opensipTools.targetDomain` → `packageTargetDomain`), falling back to the
  domain being loaded only when the pack declares none
  (`capability-loader.ts`: `targetDomainId ?? packageTargetDomain ?? domainId`).
  The bundled `graph-*` adapters declare `targetDomain: graph-adapter`, so when
  MCP's `mcp-graph-adapter` domain discovers them (by markerKind) they register
  through graph's own `graph-adapter` registrar into `scope.graph.adapters` —
  which is what `refresh_graph`'s `runGraph` reads. Existing single-domain loads
  are unchanged (`packageTargetDomain === domainId` for graph's own load), so this
  is a strict generalization, not a behavior change for existing tools.
- **Symbol identity contract:** `search_symbols`/`get_symbol` return
  `symbolId = "${filePath}:${line}:${column}"` plus `bodyHash`; downstream tools
  accept `symbolId` (not bare names); ambiguous name queries return a structured
  candidate list or error — never a silent pick.
- **Trust model:** stdio inherits the caller's filesystem trust (the agent runs
  as the user); **no network port is bound, no socket opened**, so there is no
  auth layer because there is no network surface to authenticate. `refresh_graph`
  is **parse-only** (tree-sitter parse + static analysis via `runGraph`); it never
  executes project code, runs no build scripts, and loads only the bundled
  first-party `graph-*` adapters. Concurrent refresh is serialized; reads pin an
  immutable catalog generation and `refresh_graph` swaps atomically (TOCTOU-safe).
- **Lifecycle:** the server blocks until stdin EOF, then exits cleanly (exit 0).
  SIGINT closes the transport and exits. `opensip mcp` is a transport, not an
  analysis run: it returns **no `ToolSessionContribution`** and the host persists
  no `StoredSession` for the serve lifetime.
- **v1 limitations:** no cloud egress / no `SignalEnvelope` delivery sink; no live
  render; `impact_of_diff` (parent-spec Feature 2) is deferred — not in the v1
  tool surface. `refresh_graph` threads graph's existing `graph:` config via
  `runGraph` (MCP adds no `mcp:` config block).

**Fitness check:** every structural invariant this ADR introduces is paired with
its enforcement (an ADR without this section is incomplete):

| Invariant | Evaluation | Enforcement |
|-----------|-----------|-------------|
| Result/history tools replay persisted sessions; **never re-run** `fit`/`graph`/`sim`/`yagni` | **Check warranted** | NEW `mcp-results-no-rerun` — `packages/fitness/checks-typescript/src/checks/architecture/mcp-results-no-rerun.ts`; references this ADR in a top-of-file comment. |
| MCP (a first-party tool) must not own session timing / name `SessionRepo` | **No new check** | Existing `architecture-session-timing-not-host-owned` (`opensip-cli/fit/checks/no-tool-owned-session-timing.mjs`) auto-governs `packages/mcp/` once it joins `bundledPackages`. |
| MCP must not raw-query `DataStore.db` (reads via `CatalogRepo` / session-store read API) | **No new check** | Existing `restrict-raw-db-access` (`opensip-cli/fit/checks/restrict-raw-db-access.mjs`). |
| No `mcp → cli` import edge; `graph/internal` import scoped to `packages/mcp/` only | **No check warranted** | dependency-cruiser (the layer DAG + the scoped `no-cross-package-internal` exception); a fitness check would duplicate depcruise. |
| `opensip mcp` uses `output:'raw-stream'` + `rawStreamReason:'mcp-stdio'` | **No new check** | `raw-stream-parity` inventory test + `command-handler-host-owned-output` (the in-file justification comment). |
| ADR-0009 internal-import exception is MCP-only | **No check warranted** | The narrowed dependency-cruiser `no-cross-package-internal` rule. |

**Related specs / ADRs:** implemented by the local plan
`docs/plans/ready/02-mcp-server/`. Related:
[ADR-0009](ADR-0009-public-api-surface-policy.md) (internal-surface boundary,
excepted here), [ADR-0006](ADR-0006-derived-data-persistence-policy.md) (catalog
as derived data), [ADR-0030](ADR-0030-authored-tool-discovery.md) (tool trust
tiers — `@opensip-cli/mcp` is bundled first-party and fails closed).
