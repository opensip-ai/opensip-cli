---
status: active
last_verified: 2026-06-03
owner: opensip-cli
---

# ADR-0009: Explicit public-API surfaces; internals and persistence schema stay owner-private

```yaml
id: ADR-0009
title: Explicit public-API surfaces; internals and persistence schema stay owner-private
date: 2026-06-03
status: active            # active | superseded | deferred
supersedes: []
superseded_by: null
related: [ADR-0007]       # marker-canonical discovery (same "explicit, enforced contract" posture)
tags: [architecture, modular-monolith, api-surface, persistence]
enforcement: mechanizable
enforcement-reason: >
  dependency-cruiser forbids cross-package imports of any path segment named
  `internal/` (and of `*/schema/*` outside the owning package); the package
  barrels expose only the curated public surface. Test-only helpers are reached
  via an explicit `<pkg>/internal` subpath that sibling production code may not
  import.
```

**Decision:** Every workspace package has a single, curated **public API** (its
package barrel). Anything exported only to support cross-package *tests* — or
that exposes a package's internal mechanics — does **not** belong in that
barrel. It moves behind an explicit `<pkg>/internal` subpath (test/contract
kit) that production code in other packages may not import. Two corollaries:

1. **The kernel is tool-agnostic.** `@opensip-cli/core` carries no
   tool-specific vocabulary. Fitness/check-shaped names
   (`CheckDisplayEntry`, `checksRegistered`, `totalChecks`) move into the
   fitness engine; what stays in core is generic (`PluginDisplayEntry`,
   generic registration counts).
2. **Persistence has a single owner.** Schema/table symbols and the raw
   Drizzle handle are owner-package-internal. Cross-module data access goes
   through repositories (`SessionRepo` and peers), never raw tables.

**Alternatives:**

- *Leave convenience exports as-is (status quo).* Rejected: barrel exports
  become de-facto public API. Internals visible to siblings make later
  extraction harder and invite direct cross-module coupling (raw-table access,
  pipeline-internal reuse) that no rule currently forbids.
- *Split every package into `@scope/pkg-core` + `@scope/pkg-internal` npm
  packages.* Rejected as too heavy: a subpath export (`<pkg>/internal`) gives
  the same import-boundary enforcement without doubling the package count or
  the release matrix.
- *Generalize core's check vocabulary in place (keep the names in core).*
  Rejected: the names are load-bearingly fitness-shaped (an icon + display
  name for a *check*). Generic counters can stay; check-named types belong to
  the tool that owns checks.

**Rationale:** The repo already enforces strong layer boundaries
(dependency-cruiser, type-aware) and an explicit-contract posture for plugin
discovery (ADR-0007). This extends the same posture inward: a package's *public
surface* is a contract, and test-only or mechanism-exposing exports erode it.
Concrete leaks found by the 2026-06-03 boundary audit:

- `packages/graph/engine/src/index.ts` re-exports `buildIndexes`,
  `ownerEdgeKey`, and individual rule predicates "required by cross-package
  integration tests" (M1).
- `packages/core/src/plugins/types.ts` defines `CheckDisplayEntry` and the
  `checksRegistered`/`totalChecks` plugin-result fields — fitness vocabulary in
  the kernel (M2).
- `packages/session-store/src/index.ts` exports the `sessions` /
  `sessionToolPayload` tables and `packages/datastore/src/data-store.ts`
  exposes `DataStore.db` (raw Drizzle), allowing repository bypass (M3).

**Consequences:**

- **M1** — graph (and the analogous fitness) test-only helpers move from the
  package barrel to `@opensip-cli/graph/internal`; the graph-typescript test
  suite imports them from there. Production sibling packages may not import
  `*/internal` (dep-cruiser rule).
- **M2** — `CheckDisplayEntry` + the check-count fields move to the fitness
  engine; core keeps a generic display/registration shape. Plugin-result
  consumers update their imports.
- **M3** — `sessions`/`sessionToolPayload` and the raw handle become
  owner-internal (`session-store/internal`, used by `SessionRepo` and tests
  only). A dep-cruiser rule forbids cross-package imports of `*/schema/*` and
  of the raw `db` handle outside `datastore`/`session-store`.
- A new dep-cruiser rule (`no-cross-package-internal`) plus the existing
  barrel-discipline ESLint rule enforce the boundary; `verify-gate-live`-style
  liveness keeps it real.
- Follow-up implementation lands as a separate change set per finding
  (M1 → M2 → M3), each gated independently. Each is API-shaped, so consumers
  (check packs, graph adapters) may need one-line import updates.

**Related specs / ADRs:** [ADR-0007](./ADR-0007-marker-canonical-plugin-discovery.md)
(explicit, enforced plugin-discovery contract — same posture, applied to
discovery rather than module surfaces).
