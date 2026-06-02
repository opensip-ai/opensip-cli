# Spec: Sharpen `graph:orphan-subtree` to surface only genuine dead code

> Status: **PROPOSED** (2026-06-01; revised after empirical investigation).
> Implements [ADR-0001](../decisions/ADR-0001-graph-rules-actionable-precise-bounded.md)
> (actionable/precise/bounded) and the reachability application of
> [ADR-0003](../decisions/ADR-0003-per-occurrence-edge-keying.md) (a body hash
> is not an occurrence identity).
> Related: [graph-per-package-coupling.md](./graph-per-package-coupling.md),
> [graph-edge-import-constraint.md](./graph-edge-import-constraint.md).

## Objective

`graph:orphan-subtree` emits **45 findings on this repo**, all `'medium'`, and
**every one is a false positive** (verified by classifying all 45 against the
catalog). The dominant cause is not what a first read suggests — it is the
**body-hash collapse in the reachability adjacency**, the same root cause as the
coupling/edge-keying work (ADR-0003), now striking a different derived graph.

### Root cause (proven)

`computeReachable` (`rules/orphan-subtree.ts`) BFS-walks `indexes.callees`.
`callees`/`callers` are built by `buildAdjacency` (`pipeline/indexes.ts:115-151`),
which iterates **`byBodyHash.values()`** — i.e. **one *winner* occurrence per
body hash** (last-writer-wins). So when two functions are **body-twins**
(identical bodies, different files), only the winner's out-edges enter the
graph; the loser's are erased.

Concrete proof on this repo: `analyze` in
`packages/fitness/checks-typescript/src/checks/quality/api/api-contract-validation.ts`
shares its body hash (`fc0d0d`) with `api-response-validation.ts`'s `analyze`.
`byBodyHash` kept the **api-response** copy, so `callees.get(fc0d0d)` is
api-response's callees — **not** api-contract's `analyze → analyzeFile`. The
module-init *is* a seed and *does* reach the `analyze` hash, but then follows the
wrong twin's edges. api-contract's `analyzeFile` shows **0 callers** in the
adjacency (its real caller, the losing twin, was collapsed out), so it and its
entire transitive helper chain (`getFunctionName`, `checkFunctionContract`, the
`visit` arrows, …) become **false orphans**. The `lang-*` `strip.ts` cluster is
the same mechanism (`stripStrings` and `scan` are 5-way body-twins).

This sharpens the rule so it earns a gate signal only when **actionable** (the
fix is "delete it"), **precise** (remaining findings are real dead code, not
intended public surface or twin-collapse artifacts), and **bounded** (a handful,
not 45). Target: **45 → 0–3 genuine deletions** (see Success Criteria).

## Scope

### In

- **Twin-aware reachability adjacency (the root fix).** Build `callees`/`callers`
  by **unioning every occurrence's out-edges per body hash** (from
  `occurrencesByHash`), instead of iterating `byBodyHash.values()`
  (`pipeline/indexes.ts` `buildAdjacency`/`collectOutgoing`). Over-approximating
  reachability this way is the *safe* direction for orphan detection (fewer false
  positives). Fixes `orphan-subtree` **and** `test-only-reachable` (shared
  machinery) in one place.
- **Re-measure, then handle the genuine residual.** After the adjacency fix,
  re-run and classify what remains. The expected residual is the **cross-package
  public-API** class (`cli-ui`'s `renderToText` exported and consumed only by
  `cli`, where the cross-package call edge doesn't resolve — the known
  `dependencies[].to`-empty-for-`@scope/*` gap). Handle it with the existing
  `no-callers-exported` entry-point reason, extended to `barrel-export` only if
  re-measure shows `no-callers-exported` is insufficient.
- **Rule-level precision filter** (D3) as the last-mile gate: flag only
  `module-local`/`private`, non-test, non-decorated, zero-caller, non-entry
  functions.
- Config knobs with opinionated (quiet) defaults; unit + fixture tests including
  a body-twin reachability regression and a genuinely-dead private helper that
  still fires.

### Out

- The risky `plugin-contract-closure` seeding from the earlier draft is
  **dropped** — the investigation showed it is unnecessary. The `defineCheck`
  closures' callees become reachable for free once the adjacency unions twins
  (the module-init→closure creation edge already exists; only the twin collapse
  hid the closure's own out-edges). No walker/inventory change is needed.
- Fixing the underlying **workspace import resolution** (`dependencies[].to`
  empty for `@scope/*`) — tracked in `graph-edge-import-constraint.md`. This spec
  works around it via the export-based seeding.
- Changing `test-only-reachable`'s own semantics (it benefits from the shared
  adjacency fix for free).
- `defaultSeverity` stays `'warning'` / emitted `severity` stays `'medium'`.

## Technical Context (real refs)

- **The lossy adjacency (root).** `buildAdjacency`
  (`pipeline/indexes.ts:115-125`) iterates `byBodyHash.values()`;
  `collectOutgoing` (`:127-142`) reads each *winner* occurrence's `calls`.
  `occurrencesByHash` (`types.ts` `Indexes`; built in `buildHashMaps`,
  `pipeline/indexes.ts`) already preserves **all** occurrences per hash — the
  data the twin-aware build needs; no new index required.
- **The rule.** `rules/orphan-subtree.ts`: `computeReachable` seeds from
  `inferEntryPoints(catalog, indexes)` ∪ `config.entryPointHashes`, BFS over
  `indexes.callees`; emits any `byBodyHash` occurrence not visited, except
  `kind==='module-init'` and empty `filePath`, at `severity:'medium'`.
- **Entry-point inference.** `rules/_entry-points.ts` `classify`: `module-init`
  (every file's init), `name-match` (`{main,run,start,register,initialize,init,
  bootstrap}`), `no-callers-exported` (`visibility==='exported'` AND 0 callers).
  No change needed for the root fix; `no-callers-exported` already targets the
  cross-package-export residual.
- **Occurrence levers for D3.** `FunctionOccurrence`
  (`types.ts`): `visibility: 'exported'|'module-local'|'private'`,
  `inTestFile`, `decorators`, `kind`, `package?` (stamped by `assignPackages`).
- **Tests.** `__tests__/rules/_entry-points.test.ts`,
  `__tests__/rules/orphan-subtree-config.test.ts`,
  `graph-typescript/.../rules/orphan-subtree.test.ts`. Helpers:
  `rules/_helpers.ts` (`occ`, `staticCall`, `makeCatalog`).

### The 45, re-classified (empirical, `graph --json`)

| Bucket | ~Count | Root cause | Fixed by |
|---|---:|---|---|
| **api-contract-validation.ts cluster** (`analyze`, `analyzeFile`, `getFunctionName`, `checkFunctionContract`, the `visit` arrows, …) | ~16 | **Reachability adjacency collapse** — `analyze` is a body-twin; winner's edges followed, this file's chain erased. | **Twin-aware adjacency** |
| **`lang-*/strip.ts` cluster** (`scan`, `isIdentChar`, `match*`, `scan*String`) | ~12 | Same — `stripStrings`/`scan` are 5-way body-twins; losers' edges erased. | **Twin-aware adjacency** |
| **`cli-ui/render-to-text.ts`** (`renderToText` + private helpers) | ~10 | **Cross-package export gap** — exported, consumed only by `cli`; that call edge doesn't resolve (`dist` gap). | `no-callers-exported`/`barrel-export` seeding (residual) |
| **test-only helpers** | ~4 | Module-local helper in a `*.test.ts`. | D3 filter (`!inTestFile`) |

**0 of the 45 are genuine dead code.** The first two buckets (~28) are the
ADR-0003 reachability collapse and clear once adjacency is twin-aware.

## Design Decisions

### D0 — Twin-aware reachability adjacency (root fix, ADR-0003)

Build `callees`/`callers` by unioning **every** occurrence's out-edges per body
hash (iterate `occurrencesByHash`), not the `byBodyHash` winner only. A
losing-twin's out-edges rejoin the graph, so reachability stops erasing them.
Over-approximation (a hash's callees = union of all its twins' callees) is the
correct, safe bias for orphan detection. This is the single change that clears
buckets 1–2 and the only one that *can* — no amount of extra seeding fixes a
lossy adjacency (the seeds already reach the collapsed hash).

| Option | Verdict |
|---|---|
| (a) Keep `byBodyHash` adjacency, fix via more seeding | **Rejected** — treats symptoms; can't reach a loser-twin's callees that aren't in the graph at all. |
| (b) Union per occurrence from `occurrencesByHash` (chosen) | **Chosen** — root fix; shared by `test-only-reachable`; small, contained change to `buildAdjacency`. |
| (c) Switch reachability to occurrence-id nodes (not hashes) | Cleaner in theory; larger change to the `Indexes` model and every consumer. Deferred — (b) achieves correctness within the existing hash-keyed shape. |

### D1 — Re-measure before designing residual seeding

After D0, re-run `graph --json` and re-classify. Only then finalize the
residual seeding (below). Do **not** pre-build seeding for buckets that D0 may
already clear. (Evidence-driven; the earlier draft over-built seeding against a
mis-diagnosed root cause.)

### D2 — Residual: cross-package public API

Expected residual = bucket 3 (`renderToText`). `no-callers-exported` already
classifies "exported + 0 in-project callers" as an entry point; confirm it
seeds `renderToText` post-D0. If a real barrel export is missed (e.g. it has a
stray same-package caller that is itself dead), add a `barrel-export` reason to
`inferEntryPoints`: `visibility==='exported'` AND the file is the package's
public barrel (basename `index.{ts,tsx}`, package via `occurrence.package`).
Decide based on the re-measure, not upfront.

### D3 — Rule-level precision filter

Emit only if: not reachable (existing); `kind!=='module-init'` (existing);
`filePath` non-empty (existing); **`visibility!=='exported'`** (public surface is
not dead for lack of an internal caller; configurable via `flagExportedOrphans`,
default `false`); **`!occ.inTestFile`** (`test-only-reachable`'s job;
`flagTestOrphans`, default `false`); **`occ.decorators.length===0`**
(framework-dispatched).

### D4 — Config knobs (`GraphConfig`)

| Knob | Default | Meaning |
|---|---|---|
| `flagExportedOrphans` | `false` | Allow flagging exported zero-caller functions (for repos with trustworthy cross-package resolution). |
| `flagTestOrphans` | `false` | Allow flagging `inTestFile` orphans (overlaps `test-only-reachable`). |

Opinionated default: both quiet — the platform's contract is "a finding means
delete it," so the burden of proof is on the rule. `entryPointHashes` (existing)
remains the manual escape hatch.

### D5 — Severity unchanged

`'medium'` / `defaultSeverity:'warning'`. The fix is precision, not loudness.

## Success Criteria (testable)

- [ ] **Twin-aware adjacency unit test** (`pipeline/indexes` test): two
      occurrences share a body hash but have **different** out-edges (twin A →
      X, twin B → Y); `callees.get(hash)` contains **both** X and Y. (Guards the
      ADR-0003 reachability invariant.)
- [ ] **Body-twin reachability regression** (`orphan-subtree` test): a fixture
      mirroring the `analyze`/`analyzeFile` shape — an entry reaches one twin's
      chain; the *other* twin's private callee is **NOT** orphaned after D0
      (was, before).
- [ ] **Genuine dead code still fires:** a `module-local`, zero-caller,
      non-test, non-decorated function **IS** flagged (guards against
      over-suppression).
- [ ] **D3 filter:** exported barrel fn with no internal caller is **NOT**
      flagged (default); `inTestFile` helper **NOT** flagged (default), **IS**
      with `flagTestOrphans:true`; `flagExportedOrphans:true` restores the
      exported case.
- [ ] **This repo:** `graph:orphan-subtree.violationCount` drops **45 → 0–3**,
      each remaining finding genuine dead code on manual spot-check; buckets 1–2
      contribute **0** after D0; bucket 3 contributes 0 after D2; bucket 4
      (test) contributes 0 via D3.
- [ ] **`test-only-reachable` not regressed** by the shared adjacency change
      (its own tests pass; re-measure its count).
- [ ] **Gates green:** `pnpm typecheck && pnpm test && pnpm lint`; `pnpm fit:ci`
      produces no net-new Code Scanning alerts; regenerate the orphan-subtree
      SARIF fixture if message/metadata shape changes.

## Boundaries

- **Always:** build reachability adjacency per occurrence (union per hash), not
  off `byBodyHash` winners (ADR-0003); over-approximate reachability (safe for
  orphan detection); D3 defaults quiet; `.js` ESM; pure data→data over frozen
  `catalog`/`indexes`/`config`.
- **Ask first:** adding a `barrel-export` entry-point reason (only if re-measure
  shows it's needed); changing `defaultSeverity`; switching reachability to
  occurrence-id nodes (D0c).
- **Never:** flag intended public API or framework-dispatched entries as dead;
  import `lang-*` from `rules/` (dep-cruiser `graph-pipeline-no-lang-import`);
  reintroduce the `byBodyHash`-winner adjacency; non-deterministic ordering.

## Open Questions

1. **Does `no-callers-exported` already seed `renderToText` after D0?** Resolve
   by re-measure (D1). If yes, no `barrel-export` reason is needed at all.
2. **Adjacency over-approximation scope.** Unioning twins' callees slightly
   over-approximates reachability for *every* reachability consumer. Confirm
   that's acceptable for `test-only-reachable` too (it is — over-approx → fewer
   false "test-only" flags, the safe direction).
3. **`buildBlastRadius` interaction.** Blast also consumes `callers`; but
   `high-blast` is being removed and the blast metric moves to the dashboard
   ([`high-blast-dashboard-only.md`](./high-blast-dashboard-only.md)), so the
   engine `callers` change has no blast consumer to regress. Confirm ordering if
   both land in the same release.

## Applicable Conventions

- ADR-0003 reachability invariant; ADR-0001 rubric.
- Optional, forward-compatible contract fields with documented absent-value
  semantics (the D4 knobs; `occurrence.package` fallback).
- Rules read only frozen `catalog`/`indexes`/`config`; no module-level mutable
  state.
- `rules/` may not reach into `lang-*` (dep-cruiser).
- Tests are Vitest `*.test.ts` beside source; reuse `_helpers.ts`.
- If reader-facing rule behavior changes, update `docs/public/40-graph/*` and run
  `pnpm docs:build` in the implementing PR.
