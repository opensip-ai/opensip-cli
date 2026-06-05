---
status: active
last_verified: 2026-06-04
owner: opensip-tools
---

# ADR-0013: Curate the fitness public barrel to the authoring surface, locked by an export-surface test

```yaml
id: ADR-0013
title: Curate the fitness public barrel to the authoring surface, locked by an export-surface test
date: 2026-06-04
status: active
supersedes: []
superseded_by: null
related: [ADR-0009, ADR-0011]
tags: [fitness, packaging, public-api, boundaries]
enforcement: mechanizable
enforcement-reason: >
  Two gates. (1) dependency-cruiser `no-cross-package-internal` already forbids
  production code from importing any `src/internal.ts`. (2) A new runtime
  export-surface test, `packages/fitness/engine/src/__tests__/public-api.test.ts`,
  asserts the exact set of value exports from the `@opensip-tools/fitness` barrel,
  so re-growth fails CI.
```

**Decision:** The `@opensip-tools/fitness` public barrel exports only the
check / recipe / plugin **authoring** surface plus the `fitnessTool` plugin
descriptor. Engine internals — registries, the recipe service,
`ExecutionContext`, targets/signalers config, the plugin loader, check-package
discovery, the `fit`/`dashboard`/`list-*` CLI handlers, the architecture-gate
primitives, and the persistence repos (`FitBaselineRepo`) — are removed from
the barrel. The curated surface is pinned by a runtime export-surface test.

**Alternatives:**
- *Leave the barrel broad, fix the doc instead* — rejected: it blesses
  internals (incl. a persistence repo) as contract and makes future service
  extraction harder; contradicts ADR-0009's surface policy.
- *Minimal fix — relocate only the four types the doc names as internal* —
  rejected: leaves the registries, recipe service, gate primitives, and
  `FitBaselineRepo` reachable, so the boundary stays undefendable.
- *Move everything to `./internal`* — rejected as unnecessary: nothing
  (production, CLI, cross-package tests, or fitness's own tests) imports the
  over-exported symbols *through the barrel*; fitness wires them via relative
  imports. The correct move is to drop them from the barrel, not relocate them.

**Rationale:** A boundary audit (round 4, 2026-06-04) found the fitness barrel
re-exporting ~50 symbols while
`docs/public/10-concepts/04-contract-surfaces.md` explicitly names several of
them (`CheckConfig`, `FitnessRecipe`, `RecipeCheckResult`, `ExecutionContext`)
as non-contract — a direct doc-vs-code contradiction, with a persistence repo
(`FitBaselineRepo`) the clearest leak. A consumer scan showed the *realized*
coupling through the barrel was narrow: check packs import the authoring
symbols, and the CLI imports only `fitnessTool` (+ `defineCheck`). The
over-exports were latent risk, not realized coupling, so curation is mechanical
(delete from the barrel) and converts "nobody happens to import this" into
"nobody can." This applies ADR-0009's policy concretely to fitness and mirrors
the already-curated graph barrel.

**Consequences:**
- Removing a value export from the barrel is a **major** change; adding one is
  a minor change and must be reflected in `EXPECTED_VALUE_EXPORTS` in the
  surface test (and the contract-surfaces doc).
- The export-surface test (`public-api.test.ts`) is the template for locking
  other tool barrels (graph currently has only a smoke test).
- `defineRecipe` stays public while its produced `FitnessRecipe` type stays
  unexported — the inferred return type carries it where authors need it,
  matching the doc's "`FitnessRecipe` is internal" line.

**Related specs / ADRs:** Implements ADR-0009 (public-API surface policy);
adjacent to ADR-0011 (signal output currency — why egress lives at the
composition root, not in the tool barrels).
