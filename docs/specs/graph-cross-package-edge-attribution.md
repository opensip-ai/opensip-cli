# Spec: Correct cross-package edge attribution in the graph call graph

> Status: **IMPLEMENTED** (2026-06-01) on branch
> `fix/graph-cross-package-edge-attribution` (Phases 0–5). No config setting
> (out of scope). Engine attribution + import-constrained resolution +
> dashboard mirror landed; impossible-edge behavior proven by tests.
> Residual: the dashboard catalog carries no import set, so its
> disambiguation is same-package-only (engine cross-shard already drops
> non-imported edges upstream) — a future contract-add could close it.
> Author: 2026-06-01. Targets 2.4.2.

## Objective

The dashboard **PACKAGE COUPLING** grid (and any consumer of the call graph)
must attribute each call edge to the **correct** caller/callee packages, so
the grid reflects real dependencies. Today it shows edges that are impossible
as imports — `core→fitness`, `fitness→cli`, `cli-ui→fitness` — which are
call-graph **attribution artifacts**, not real coupling.

**Who is the user?** Anyone reading the coupling grid to reason about
architecture, plus every engine rule that consumes the call graph.

**Oracle for "correct":** the dependency-cruiser-enforced import layering. A
cross-package call edge `A→B` is legitimate only if package A actually
imports package B. (depcruise is green, so the real import graph is the
ground truth.)

### Success criteria (concrete)

- Every off-diagonal edge in the coupling grid follows the import direction:
  no `A→B` cell unless A imports B. Specifically, the impossible cells
  (`core→fitness/graph/simulation`, `fitness→cli`, `cli-ui→fitness/graph`,
  `languages→fitness`, `dashboard→fitness`, `reporting→fitness`,
  `session-store→graph`) drop to **0** when graph is re-run on this repo.
- A function with an **identical body in two packages** is attributed to the
  caller's package (or an imported package), not to a collision "winner."
- No existing graph rule regresses (`test-only-reachable`,
  `duplicated-function-body`, `high-blast-function`, `no-side-effect-path`,
  `orphan-subtree`).

## Scope

### In Scope

- **Engine resolution (defect 2):** import-constrained + same-package-preferred
  resolution of cross-shard boundary calls (`cross-shard-resolve.ts`).
- **Engine attribution (defect 1):** a package-aware way to map a call
  target → callee occurrence that does not depend on the lossy
  `byBodyHash` collapse.
- **Dashboard coupling grid:** mirror the package-aware attribution in the
  browser-side coupling view so the grid is correct.
- Tests proving correct attribution on a multi-package fixture with
  identical-bodied functions, and a re-run assertion against this repo.

### Out of Scope (and why)

- **Config include/exclude file filter.** Decided not needed: the grid is
  already production-only by default (per-occurrence `inTestFile` filter), a
  test exclude doesn't fix the artifacts, and a catalog-level test exclude
  would break `test-only-reachable`. General path-scoping can be a separate,
  deliberately-designed feature if real demand appears.
- **Changing the edge target model from `bodyHash` to a unique occurrence
  id.** Architecturally cleaner but a deep change to the pipeline + the
  `GraphCatalog` contract + 64 readers. We achieve correctness additively
  instead (see Design Decisions); switching the edge id is a possible future
  refactor, not this fix.
- **The `byBodyHash.values()` under-counting** (collapsed duplicate
  occurrences are invisible to `.values()` iteration). Real latent bug, but
  broader than coupling attribution — flagged for a follow-up unless it falls
  out for free.

## Technical Context

### Existing architecture

- **Index:** `Indexes.byBodyHash: ReadonlyMap<string, FunctionOccurrence>`
  (`packages/graph/engine/src/types.ts:293`), built in
  `pipeline/indexes.ts` (`byBodyHash.set(o.bodyHash, o)`, ~line 50) —
  **one occurrence per body hash, last-writer-wins.** `bySimpleName:
  Map<string, string[]>` (name → bodyHashes).
- **Edges:** a `CallEdge.to` is `bodyHash[]`. Consumers find the callee via
  `byBodyHash.get(targetHash)` — which returns the collision winner when
  multiple packages share a body.
- **Cross-shard resolution:** `cli/orchestrate/cross-shard-resolve.ts`
  `resolveOne` (~127-178) matches unresolved boundary calls by **global
  simpleName**; `pinBySpecifier` constrains **only relative** (`./`)
  imports. Bare workspace imports (`@opensip-tools/*`) are unconstrained.
- **Imports are captured:** `FunctionOccurrence.dependencies?: DependencyEdge[]`
  (`{ specifier, to: bodyHash[] }`) on `module-init` occurrences
  (`types.ts:~137-148, 194`). **Populated in `exact` mode only**, absent in
  `fast` mode.
- **Package identity:** derived from `filePath` (`/^packages\/([^/]+)\//`);
  the dashboard already has `packageOfPath()` in
  `dashboard/src/code-paths/path-utils.ts`.
- **Dashboard builds its OWN browser-side index**
  (`dashboard/src/code-paths/indexes.ts`, same collapse) from the catalog
  JSON; `view-coupling.ts` is browser JS emitted as a `String.raw` template.
  The engine's `Indexes` does **not** reach the dashboard — the dashboard fix
  is separate.

### Key dependencies / packages touched

- `@opensip-tools/graph` (engine): `pipeline/indexes.ts`,
  `cli/orchestrate/cross-shard-resolve.ts`, package-aware attribution helper,
  rule audit.
- `@opensip-tools/dashboard`: `code-paths/indexes.ts`,
  `code-paths/view-coupling.ts`, `code-paths/path-utils.ts`.
- `@opensip-tools/contracts`: `GraphCatalog` — prefer **no** change.

### Constraints

- Both `exact` and `fast` resolution modes (fast has no `dependencies[]` →
  same-package preference only, no import-set constraint).
- Preserve the sharded build, per-shard incremental cache, and cross-shard
  edge recovery.
- No `--json` `CliOutput` change; avoid `GraphCatalog` contract change.
- All gates green (`pnpm typecheck && pnpm test:coverage && pnpm lint`).
- ESM Node16 (`.js`), Node 22+, TS 5.7.

## Design Decisions

| Decision | Choice | Rationale | Alternatives considered |
|---|---|---|---|
| Attribution model | **Additive: keep `byBodyHash` as the content-dedup map; add `occurrencesByHash: Map<bodyHash, readonly FunctionOccurrence[]>` (all occurrences sharing a body) + a `resolveCallee(targetHash, callerOcc, indexes)` helper** | Lowest-risk path to correctness across 64 readers + a separate dashboard index. Content-keyed consumers keep working; only attribution-sensitive ones switch to the helper. | (a) Change `byBodyHash` to `Map<hash, occ[]>` — ripples to 64 readers, high regression risk. (b) Change edge target to a unique occurrence id (qualifiedName) — deep pipeline + contract change. Both rejected for this fix. |
| Callee disambiguation order | **same package as caller → a package the caller's module imports (`dependencies[]`) → deterministic fallback (lowest `qualifiedName`)** | Matches reality: a call resolves to code the caller can actually reach. Deterministic fallback keeps output stable. | Arbitrary winner (current); "first by insertion" (non-deterministic). |
| Cross-shard resolution (defect 2) | **Constrain candidates in `resolveOne` to same-package ∪ caller-imported packages; prefer same-package** | Stops bare-specifier global name matching from inventing edges; uses already-captured `dependencies[]`. | Leave resolution, fix only attribution — but wrong `edge.to` still pollutes rules that don't go through the helper. |
| Fast mode | **Same-package preference only (no import-set constraint)** | `dependencies[]` is unavailable in fast mode; same-package still removes the worst artifacts. | Require exact mode — too restrictive. |
| Dashboard | **Mirror the additive index + helper in the browser-side `code-paths/indexes.ts` and `view-coupling.ts`** | The dashboard rebuilds its own index; the engine fix can't reach it. | Ship engine attribution into the catalog JSON — would need a contract change. |

## Success Criteria (testable)

- [ ] New engine test: a two-package fixture where pkg-a and pkg-b both define
      `f` with an **identical body**, and pkg-a calls its own `f`. Assert the
      resolved/attributed callee is pkg-a's `f`, not pkg-b's.
- [ ] New engine test: pkg-a imports pkg-b and calls pkg-b's unique `g`;
      assert edge attributes to pkg-b. pkg-a calls a name that exists only in
      a package it does NOT import → edge is unresolved/dropped, not invented.
- [ ] Dashboard test: coupling computation over a catalog with a cross-package
      body collision attributes to the caller/imported package (extend
      `dashboard/src/__tests__/`).
- [ ] Re-running `graph` on this repo: the impossible cells listed in
      Objective are 0; spot-check `graph-lookup` no longer implies
      `fitness→cli`.
- [ ] `pnpm typecheck && pnpm test:coverage && pnpm lint` green; no rule
      regression (existing rule tests pass unchanged).

## Boundaries

- **Always:** package-aware attribution is deterministic; both resolution
  modes handled; rule behavior preserved (verified by existing rule tests);
  `.js` ESM extensions.
- **Ask first:** any change to the `GraphCatalog` contract or `CliOutput`;
  changing the `byBodyHash` value shape (vs. the additive index); changing
  the edge target model.
- **Never:** attribute a cross-package edge that contradicts the import graph;
  introduce non-determinism in resolution; reintroduce a global by-name match
  without a same-package/import constraint.

## Open Questions

- [ ] **Helper home & reuse.** The engine helper (`resolveCallee`) and the
      dashboard helper are in different runtimes (Node vs. browser JS string).
      Accept two small parallel implementations, or factor the disambiguation
      rule into a pure, shared, dependency-free function the dashboard can
      inline? (Resolvable in planning.)
- [ ] **Does fixing defect 2 (resolution) alone clear the grid, making the
      attribution helper (defect 1) lower priority?** Likely not — body-hash
      collapse mis-attributes even correctly-resolved edges — but planning
      should confirm with a quick experiment (apply resolution fix, re-check
      grid) to order the phases.
- [ ] **`byBodyHash.values()` under-counting** — confirm whether any
      in-scope consumer relies on iterating all occurrences (would need
      `occurrencesByHash`), or whether it's strictly a follow-up.

## Applicable Conventions (from CLAUDE.md)

- **Errors:** N/A (pure analysis; no new error types expected).
- **Logging:** existing graph `evt` logging; add a debug counter for
  dropped/over-ridden cross-package edges if cheap.
- **Config:** none (explicitly out of scope).
- **DI / RunScope:** none; pure functions over the catalog/indexes.
- **Testing:** Vitest; engine tests beside source + fixtures under
  `packages/graph/engine/src/__tests__/`; dashboard tests under
  `packages/dashboard/src/__tests__/`. Coverage thresholds enforced.
- **Layering:** dashboard depends on contracts only; engine fix must not add
  cross-layer deps; depcruise stays green.
