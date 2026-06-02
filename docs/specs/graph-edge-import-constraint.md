# Spec: Import-constrained cross-package edges (engine post-resolution pass)

> Status: **IMPLEMENTED** (2026-06-01) on branch
> `fix/graph-edge-import-constraint-pass`. Targets 2.4.2.
> Follow-up to [graph-cross-package-edge-attribution.md](./graph-cross-package-edge-attribution.md),
> which fixed body-hash-collision *attribution* but did not remove false
> edges that are not collisions.

## Objective

The dashboard PACKAGE COUPLING grid still showed import-impossible edges
(`core→fitness`, `fitness→cli`, `cli-ui→fitness`, …) after the attribution
fix shipped. Root cause, confirmed against the freshly-persisted catalog:

1. **Wrong build mode targeted.** The prior fix constrained *cross-shard*
   resolution (`cross-shard-resolve.ts`), but `graph` on this repo runs a
   **single whole-repo TypeScript program** (no sharding), so that code path
   never executes. The false edges come from the *intra-program* resolver
   `resolveByCatalogFallback`, which matches a globally-unique simple name
   across **all** packages and links to it — even into a package the caller
   never imports.
2. **These are not body-hash collisions.** The target hash has a single
   occurrence (in the wrong package), so collision-disambiguation
   (`resolveCallee` same-package preference) cannot help, and the dashboard
   has no import set to drop them with.

**Success:** every off-diagonal coupling cell follows the real import graph;
no legitimate cross-package edge is lost.

## Design

A mode-agnostic **post-resolution pass**,
`constrainCrossPackageEdges(catalog, packageGroupMap)`
(`packages/graph/engine/src/pipeline/constrain-edges.ts`), applied to the
built catalog **before persistence** in both orchestration paths
(`cache-orchestrator.ts` single-program, `sharded-graph.ts` sharded).

For every **name-guessed** edge (`resolution` ∈ {`unknown`, `dynamic-string`,
`syntactic`}) it keeps only targets whose body hash has at least one
occurrence in a package the caller can **reach** — the caller's own package,
or one its module imports. **Type-checker-backed** edges (`static`,
`method-dispatch`, `jsx`, `constructor`) are never touched, so legitimate
edges, including re-export indirection the import set wouldn't capture, are
preserved.

| Decision | Choice | Rationale | Rejected |
|---|---|---|---|
| Constraint layer | Post-resolution catalog pass before persist | Mode-agnostic; the dashboard + every rule read the constrained catalog | Patch `resolveByCatalogFallback` (single-program only, no caller import context mid-walk); dashboard-only patch (no import set in browser) |
| Which edges | Name-guessed only (`unknown`/`dynamic-string`/`syntactic`) | Type-checker edges already reflect reachable symbols; constraining them risks dropping re-export indirection | Constrain all edges (false negatives) |
| Import set source | `dependencies[]` **specifiers** → workspace name→group map (`workspace-package-map.ts`, reads `packages/**/package.json` names) | The TS resolver points workspace imports at built `dist/*.d.ts` outside the catalog, so `dependencies[].to` is **0% resolved** for cross-package imports; only the raw specifier is reliable | `dependencies[].to` (empty → over-drops every legit cross-package edge) |
| Non-monorepo / fast mode | No-op (empty package map / no `dependencies[]`) | Can't reliably constrain without an import graph | Same-package-only (over-drops) |

## Success Criteria (verified)

- [x] On this repo, all 24 off-diagonal coupling cells follow the real
      import graph — **0 oracle violations** (oracle = specifier-level import
      edges). Impossible cells (`core→fitness`, `fitness→cli`, …) are 0.
- [x] Legit cells preserved: `fitness→core` 37, `graph→core` 21, `cli→core`
      28, `cli→graph` 4, `simulation→core` 10. (`cli→fitness` drops 35→1,
      matching "the CLI has zero direct fitness imports beyond the tool
      exports.")
- [x] Engine + package-map unit tests; `pnpm typecheck && pnpm test:coverage
      && pnpm lint` green; `pnpm fit` 112 passed / 0 warnings.

## Known follow-up (not in scope)

The graph's **dependency edges themselves** are broken for workspace
imports — `dependencies[].to` resolves 0/891 `@opensip-tools/*` specifiers
(they point at `dist/*.d.ts`, outside the catalog). This pass sidesteps it by
reading specifiers, but the `depends_on` edge graph is silently empty across
package boundaries. Fixing import resolution to point at source is a separate,
larger change.
