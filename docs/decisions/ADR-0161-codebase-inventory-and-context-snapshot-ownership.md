---
status: active
last_verified: 2026-07-12
owner: opensip-cli
---

# ADR-0161: Separate Codebase Facts From Graph-Owned Context Snapshots

```yaml
id: ADR-0161
title: Separate codebase facts from graph-owned context snapshots
date: 2026-07-12
status: active
supersedes: []
superseded_by: null
related: [ADR-0037, ADR-0084, ADR-0147, ADR-0148, ADR-0149, ADR-0152, ADR-0153, ADR-0160]
tags: [architecture, inventory, graph, persistence, mcp]
enforcement: mechanizable
enforced-by: ['depcruise:codebase-imports-core-contracts-targeting-only', 'depcruise:mcp-graph-internal-scope', 'script:inventory.test.ts', 'script:manifest-facts.test.ts', 'script:context-snapshot-repo.test.ts', 'script:sqlite-graph-read-port.test.ts', 'script:context-observability.test.ts', 'script:e2e-stdio.test.ts']
```

**Decision:** `@opensip-cli/codebase` is a layer-3, persistence-free substrate
that derives bounded project, package, file-role, target, and allowlisted script
facts from the captured project root and `TargetResolver`. It owns no Tool,
datastore, graph, suite, or MCP registration.

The first task-context release accepts explicit project-relative files only.
Graph combines immutable inventory facts with its catalog to compute impact,
entity detail, and labelled static test candidates, and graph owns persistence
for derived inventory/test-selection snapshots. MCP crosses only captured
`CodebaseReadPort`, `GraphReadPort`, `ContextReadPort`, and the public
`@opensip-cli/graph/read` facade. Recorded pointers are checked exactly and are
never rebound to a newer generation or snapshot.

**Alternatives:**

- **Let MCP scan and persist inventory.** Rejected because transport handlers
  must remain read adapters, not evidence owners.
- **Expose graph repositories or raw SQLite to MCP.** Rejected because it breaks
  the public graph-read boundary and makes storage evolution a protocol concern.
- **Accept Git selectors or free-form task intent now.** Rejected because the
  first release requires deterministic, caller-declared scope.
- **Read source snippets or execute selected tests.** Rejected because context
  answers are static evidence and commands, not an execution or code-disclosure
  surface.
- **Store snapshots in generic sessions or tool_state.** Rejected because these
  are graph-derived immutable generations with different identity and retention
  semantics.

**Rationale:** Inventory facts are useful below both graph and MCP and should be
testable without persistence. Derived selection needs the graph generation and
therefore belongs with graph. Narrow ports preserve per-process captured scope,
make ordinary reads incapable of rebuilding evidence, and give tests one fake
per filesystem/storage boundary.

**Consequences:**

- Inventory is capped at 20,000 files, 2,000 packages, 64 allowlisted scripts
  per package, eight target memberships per file, and 1 MiB per manifest read.
- Graph context payloads are capped at 8 MiB, retain at most three per kind and
  24 MiB total, and use explicit numeric payload versions.
- Test candidates always state basis/confidence and `observed: false`;
  incomplete answers carry caps, uncertainty, and package/full fallbacks.
- Symlink escapes, unsafe scripts, traversal/absolute inputs, stale generations,
  and evicted pointers produce qualified negative answers rather than bare
  empty results.

**Related:** [ADR-0037](ADR-0037-generic-targeting-runtime.md) owns canonical
targets, [ADR-0147](ADR-0147-public-graph-read-and-fail-closed-package-boundaries.md)
owns the graph facade, and [ADR-0160](ADR-0160-deterministic-task-context-evidence-plane.md)
owns host aggregation.

**Related:** The local-only agent-task-context spec records
the deferred intent, history, observed-coverage, resource, snippet, Git, and
task-composer waves.
