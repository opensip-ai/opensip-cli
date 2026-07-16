---
status: active
last_verified: 2026-07-11
owner: opensip-cli
---

# ADR-0154: Bridge declarative runtime handlers without inventing call edges

```yaml
id: ADR-0154
title: Bridge declarative runtime handlers without inventing call edges
date: 2026-07-11
status: active
supersedes: []
superseded_by: null
related: [ADR-0147, ADR-0148, ADR-0149, ADR-0152, ADR-0153]
tags: [mcp, runtime-wiring, command-spec, inventory, audit]
enforcement: mechanizable
enforced-by: ['local:first-party-command-static-handler', 'script:command-spec.test.ts', 'script:runtime-command-inventory.test.ts', 'script:build-runtime-command-inventory.test.ts', 'script:static-handler-bridge.test.ts', 'script:live-runtime-wiring-read-port.test.ts', 'script:e2e-stdio.test.ts', 'depcruise:no-cross-package-internal']
enforcement-reason: >
  Validated CommandSpec descriptors, plain RunScope inventory projection, pure
  bridge matching, live port injection, first-party dogfood metadata completeness,
  and package-boundary depcruise rules enforce the runtime bridge contract.
```

**Decision:** Runtime wiring captures a **complete plain host+Tool command
inventory** on per-invocation `RunScope` and optionally bridges author-declared
static handler descriptors to declaration facts **without** inventing call-graph
edges.

- **Descriptors:** `CommandSpec.staticHandler` is a frozen three-field object
  (`package`, project-relative `path`, `declaration`) with strict bounds
  (package ≤214, path ≤1024, declaration ≤256). Accessors and revoked Proxies are
  rejected at definition time.
- **Inventory:** The CLI composition root projects the exact spec arrays used for
  mounting into a bounded frozen `RuntimeCommandInventory` (host groups/leaves,
  Tool commands, plugin paths, aliases, internal workers, owners, admitted
  provenance). No functions, Commander objects, or live handlers are retained.
  Stable content identity is `w1:` (excludes `capturedAt` volatility).
- **Bridge:** MCP joins descriptors to declaration candidates through an injected
  batch read over one captured `g1:` generation. Outcomes are labelled
  (`resolved`, `not-found`, `ambiguous`, `provenance-mismatch`,
  `candidate-cap`, `catalog-missing`, `declarations-unsupported`, …) with
  **author-declared** claim provenance, match basis, and confidence. Only the
  reviewed first-party shared mappings (`@opensip-cli/contracts`,
  `@opensip-cli/external-tool-adapter`) may cross package identity; third-party
  tool claims must match admitted package identity.
- **Cache:** Completed successes cache by `w1:`+`g1:` (max 4 entries; prune older
  generation for same `w1:`). Failures are not cached. Runtime-only follow-ups
  observe externally persisted newer catalogs without a build or intervening
  static graph query.
- **Edge kinds:** Overlay labels `command-dispatches-handler` edges only. Runtime
  edges never become call or import edges.

**Alternatives:**
- Reflect live handler functions / stringification — rejected: privacy and
  non-determinism; exposes source and breaks immutability.
- Import CLI composition into MCP — rejected: layering violation and couples MCP
  to host internals.
- N+1 public `search_declarations` per leaf — rejected: unbounded freshness and
  query cost; batch generation capture is required.
- Invent call edges from handler metadata — rejected: runtime composition is not
  static reachability (carried from ADR-0149).

**Rationale:** Audits need “which command runs which function?” without
pretending registration is a call edge. Plain data on RunScope keeps MCP free of
CLI imports while the composition root remains the only inventory authority.

**Consequences:**
- Every first-party CommandSpec leaf must declare `staticHandler` metadata
  (dogfood: `first-party-command-static-handler`).
- Production ceilings: 2,000 leaves / 1,000 groups inventory; 2,000 descriptors /
  8 candidates per batch; 4 cache entries.
- `get_runtime_wiring` returns canonical project root context and never leaks
  datastore/executable paths, raw manifests, or environment.

**Fitness check:** Check warranted — the first-party source invariant is cheap
and repository-specific; assembled runtime tests remain the authoritative
catch-all.

**Related specs / ADRs:** ADR-0153 (compact MCP protocol / surface diagnosis);
ADR-0152 (declaration plane used by the bridge); ADR-0148 (catalog auto-swap).
