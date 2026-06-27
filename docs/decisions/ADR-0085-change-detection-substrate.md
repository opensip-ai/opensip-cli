---
status: active
last_verified: 2026-06-27
owner: opensip-cli
---

# ADR-0085: Host-owned change-detection substrate & cross-tool impact read

```yaml
id: ADR-0085
title: Host-owned change-detection substrate and cross-tool impact read
date: 2026-06-27
status: active
supersedes: []
superseded_by: null
related: []
tags: [agents, fitness, graph, contracts, layering]
enforcement: mechanizable
enforcement-reason: >
  `single-changed-file-resolver` and `single-agent-filter-engine` enforce one
  implementation for changed-file derivation and agent filtering; the fitness→graph
  no-edge invariant is enforced by dependency-cruiser tool-engine rules.
```

**Decision:** Place the git changed-file resolver in `@opensip-cli/core`
(`resolveChangedFiles`); place the agent-filter engine (`applyAgentFilters`,
`agentRunFlagSpecs`, `buildAgentFilteredResult`), pure impact compute
(`computeImpact`), and `GraphImpactResult` in `@opensip-cli/contracts`;
and wire `fit --include-impacted` to read the graph catalog through a generic
`RunScope.graphCatalog` thunk (`() => unknown`, declared on core's
`ScopeContribution`). The graph tool INSTALLS the thunk from its own
`contributeScope()` hook (the same IoC seam as `scope.graph`); the thunk reads
the per-run datastore lazily via `currentScope()` and returns
`CatalogRepo.loadCatalogContract()`, cast to `GraphCatalog` at the fitness
boundary. The host never statically imports `@opensip-cli/graph` (install-source
independence, ADR-0009/0027/0029) — the thunk type stays generic so fitness
reads it without a `@opensip-cli/graph` edge.

**Alternatives:**

- **Fitness imports `@opensip-cli/graph`** — rejected; forbidden tool→tool edge
  (dependency-cruiser `tool-engines-*` rules).
- **Fitness raw-SQL reads `graph_catalog`** — rejected; couples fitness to
  graph-owned schema (audit H1 already removed this pattern).
- **`computeImpact` lives in the graph engine, called by fitness** — rejected;
  same tool→tool edge as (a).

**Rationale:** Agents need one filter engine for live runs and session replay,
one git resolver for `fit --changed` and `graph impact`, and one impact
implementation over the `GraphCatalog` contract. Contracts-hosted pure compute
plus a host-wired scope thunk preserves the DAG, enables faked catalog reads in
fitness tests, and keeps core contracts-free.

**Consequences:**

- The graph tool installs one more lazy thunk (`graphCatalog`) via its
  `contributeScope()` hook; the host adds no static graph import.
- `computeImpact` reads precomputed `features.blast` when present; catalogs
  without `features` still yield a correct impacted closure (blast tier skipped).
- Filtered live runs emit a compact view but deliver/persist the unfiltered
  envelope for gate, egress, and session columns.

**Fitness check:** **Check warranted** — `single-changed-file-resolver` (only
`core/lib/git-changed-files.ts` derives changed files) and
`single-agent-filter-engine` (only `contracts/agent-filters.ts` implements
agent filtering) enforce the one-implementation halves. **No additional check
for the fitness→graph no-edge invariant** — already enforced by
`.config/dependency-cruiser.cjs` `tool-engines-*` rules.