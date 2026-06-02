# Spec: Per-package coupling bucketing + body-twin edge keying

> Status: **IMPLEMENTED** (2026-06-01), folded into 2.4.2.
> Follow-up to [graph-edge-import-constraint.md](./graph-edge-import-constraint.md)
> and [graph-cross-package-edge-attribution.md](./graph-cross-package-edge-attribution.md).

## Objective

Two issues, surfaced while reviewing the coupling grid:

1. **Bucketing was a path heuristic, not the real package.** The grid grouped
   files by the first segment under `packages/` (`/^packages\/([^/]+)\//`).
   That collapsed the 29 workspace packages into 12 directory groups and
   **degenerated to a single `<unknown>` bucket on any repo not laid out under
   `packages/`** — so the grid was unusable on the arbitrary repos `graph` is
   meant to analyze.
2. **Call edges were unioned across body-twins.** Edges were bucketed by owner
   `bodyHash` alone; functions with identical bodies in different files (e.g.
   `stripStrings`/`stripComments` duplicated across the 5 language adapters)
   shared one edge list, so each twin appeared to call every twin's callees —
   20 phantom `lang-*→lang-*` edges, invisible at the old group granularity.

**Success:** the grid shows real packages on any layout; every off-diagonal
cell follows the real import graph (0 oracle violations); no legit edge lost.

## Design

| Decision | Choice | Rationale |
|---|---|---|
| Package identity | Nearest enclosing `package.json` `name`; else top-level path segment. Stamped per occurrence (`occurrence.package`) at build time by `assignPackages`. | The universal "what package is this file in"; portable to `packages/`, `apps/`+`libs/`, single-package, non-JS. The dashboard has no FS, so it must be carried in the catalog. |
| Contract | Add optional `package?: string` to `GraphFunctionOccurrence`. | Additive, forward/backward compatible; consumers fall back to the path heuristic via `pkgOf`. |
| Import set | From `dependencies[]` **specifiers** (specifier = package name = `occurrence.package`). | `dependencies[].to` is empty for workspace imports (resolver points at `dist`). Subsumes the prior `packageGroupMap`. |
| Body-twin edges | Key edges by `(bodyHash, filePath)` via `ownerEdgeKey`, end to end (resolver, `stitchEdges`, incremental merge, dependency attach, `collectByOwner`). | The only correct fix; a hash-only key cannot distinguish twins. `filePath` matches `occurrence.filePath` byte-for-byte (same raw `relative()`). |

## Success Criteria (verified on this repo)

- [x] Grid shows the real **29** packages (was 12); `package` field 100% populated.
- [x] **0** oracle violations (off-diagonal cells all import-backed); the 20
      `lang-*→lang-*` phantoms gone (`lang-cpp stripStrings` → 1 self edge).
- [x] Legit cells preserved (`fitness→core` 37, `checks-typescript→fitness` 79,
      `graph-typescript→graph` 10).
- [x] Regression test: body-twin `work()` keeps only its own-file `helper` edge.
- [x] `pnpm typecheck && pnpm test:coverage && pnpm lint` green; `fit` 112/0;
      `verify-release v2.4.2` green.

## Out of Scope

- Per-package vs. by-group **toggle** — per-package is the correct portable
  default; a configurable grouping can be added later if demand appears.
- Fixing the underlying **workspace import resolution** (`dependencies[].to`
  empty for `@scope/*`) — tracked separately; this work reads specifiers instead.
