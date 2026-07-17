---
status: active
last_verified: 2026-07-09
owner: opensip-cli
---

# ADR-0147: Public graph/read and fail-closed package boundaries

```yaml
id: ADR-0147
title: Public graph/read and fail-closed package boundaries
date: 2026-07-09
status: active
supersedes: []
superseded_by: null
related: [ADR-0084, ADR-0009, ADR-0107, ADR-0133]
tags: [graph, mcp, architecture, depcruise, packaging]
enforcement: mechanizable
enforced-by: ['depcruise:no-cross-package-internal', 'depcruise:mcp-graph-internal-scope', 'script:verify-depcruise-export-paths', 'script:workspace-tool-package-inventory', 'script:public-read-surface']
enforcement-reason: >
  Export path verifier, both depcruise lanes, tool inventory, and graph
  public-read surface lock prove complete source maps and MCP consumption of
  graph/read only.

**Decision:** Graph exposes a stable public subpath `@opensip-cli/graph/read` of
free functions returning `Result` / canonical DTOs for catalog identity,
generation load, analysis wrappers, and rebuild. Repositories, rules, and
orchestration stay private. MCP production imports only `graph/read` (not
`graph/internal`). Dependency-cruiser path maps are derived from every declared
workspace export; omitted subpaths fail the verifier. Production Tool path
policy is derived from manifests (`opensipTools.kind === 'tool'`), not handwritten
regex inventories. Peer Tool isolation is allowlist-shaped for external Tools.
Public `DataStore` has no raw `transaction` callback; tables and test identities
are not public barrel exports.

**Alternatives:**
- MCP permanent exception for graph/internal — rejected: blesses a permanent bypass.
- Handwritten tool path inventories — rejected: rot when packages are added.
- One-implementation service/class hierarchy for graph reads — rejected: free
  functions over existing algorithms are enough.

**Rationale:** Complete resolved edges make architecture gates real; a narrow
public read facade gives MCP a durable boundary for Spec 21 without leaking
persistence objects.

**Consequences:**
- `scripts/lib/workspace-{package-manifests,export-map,tool-package-inventory}.cjs`
  are the shared inventory.
- Sanctioned datastore/internal consumers: session-store + graph persistence only.
- Spec 21 MCP audit-readiness begins only after this architecture plan is green.
