# Graph False-Findings — Incident Log & Consolidation Plan

**Status:** RESOLVED (2026-06-11 — production resolved-edge divergence 204 → 12 → 1
→ **0** on one shared model, ADR-0033). The differential guardrail is now the true
zero-divergence soundness invariant (all directional floors 0). Remaining gaps are
both-engine-decline completeness items (cross-package + arrow-property method
calls), guarded by the pinned-corpus completeness floor — see the 2026-06-11
entries + "Still open" below.
**Scope:** the `graph` tool reporting warnings/errors that are not real, recurring
across multiple "fix" attempts.

This is a **living record**. Every time the symptom reappears, append a dated entry
under "Recurrence Log" with: how it was observed, what we found, what we changed,
and how we verified. We have "fixed" this several times and it keeps coming back —
the point of this file is to make the trail verifiable so the next occurrence starts
from knowledge, not from scratch.

---

## Symptom

Running `graph` after code changes shows warnings/errors (e.g. `graph:cycle`,
`graph:large-function`) that, on inspection, are **already waived** with
`@graph-ignore` directives or are otherwise not real. CI/dogfood and piped runs look
clean; the developer's terminal does not.

## The meta-pattern (why this was so hard to catch)

**The bug only manifests in an interactive terminal (TTY).** Investigations run
non-interactively (piped output, CI, an agent shell) take a *different code path*
where suppression IS applied → they show 0 findings → the investigator concludes
"not a real issue." The reporter, in a real terminal, takes the path where
suppression is **skipped** → sees the warnings. Two different code paths, same
command. Always reproduce in (or emulate) a TTY:

```bash
# emulates a terminal even from a script/agent:
script -q /dev/null node packages/cli/dist/index.js graph
```

---

## Root Cause (confirmed 2026-06-09)

`graph` forks into multiple build/dispatch paths chosen by **ambient runtime state**,
and critical post-build steps are not shared across them.

### Defect A — interactive path bypasses suppression  ← causes the false warnings

- `applyGraphSuppressions` is called in only two places, both inside `executeGraph`:
  - `packages/graph/engine/src/cli/graph.ts:434` (multi-path)
  - `packages/graph/engine/src/cli/graph.ts:516` (`dispatchGraphResult`)
- A bare `graph` in a TTY is routed *away* from `executeGraph`:
  - `packages/graph/engine/src/cli/graph/graph-command-spec.ts:211-231`
    ```ts
    if (isInteractiveDefault && process.stdout.isTTY === true) {
      await dispatchGraphLiveView(opts, cli, resolution);  // suppression-FREE
      return;
    }
    const envelope = await executeGraph(...);               // suppression-APPLIED
    ```
- The live path consumes **raw, unwaived** signals end to end:
  - `graph-runner.tsx:157` (`runGraph`), `:218` persist raw, `:221-225` verdict from raw, `:236` rendered findings from raw
  - `graph-worker.ts:58-70` (worker returns raw signals)
  - `graph-report.ts:51-56` (`buildLiveGraphOutput` passes `signals` through unfiltered)
- Net: TTY run → all `@graph-ignore` waivers leak as warnings; piped/CI run →
  `executeGraph` → suppression applied → 0.
- **Empirical confirmation (2026-06-09):** non-TTY `graph` → `0 Warnings`;
  `script -q /dev/null … graph` (forced TTY) → single-program engine, 15,933
  functions, **8 Warnings** (the repo's `@graph-ignore` set leaking).

### Defect B — engine/path non-determinism + shared cache-row clobbering  ← causes run-to-run flakiness

- TTY → live **single-program** engine (`runGraph`). Pipe/CI/`--json`/`--gate-*` →
  static path which may **shard** (`graph.ts:145` `resolveShards`).
- Single vs sharded produce **different catalogs**: single ≈ 15,9xx functions,
  sharded ≈ 13,554 — a ~2,400-function gap (exact vs approximate engine).
- Both write the **same single catalog row** (`graph_catalog` id=1) with
  structurally incompatible cache keys:
  - single: `eng=3.0.0|ts-6.0.3-exact-<hash>` (`cache-orchestrator.ts:65` via `stampEngineVersion`, `engine-version.ts:50`)
  - sharded: `sharded-32-<hashKeys(fragments)>` (`cross-shard-resolve.ts:108`) — **never** run through `stampEngineVersion`, and each shard key hashes its *own* package tsconfig (`shard-runner.ts:122`)
  - → every mode switch trips `graph.cache.invalidate.miss reason="cache-key-changed"` (`invalidate.ts:59-67`) → full rebuild; consumers (gate baseline, dashboard, lookup, symbol-index) read whichever engine last wrote.
- `process.stdout.isTTY` selecting the **engine** (not just the renderer) is the core
  smell: how we *draw* should never change *what we build*.

### Ruled OUT this round (do not re-chase without new evidence)

- **`--no-cache` broken** — it is wired correctly through static, sharded, and live
  paths. The `catalog.read.hit`-under-`--no-cache` observation was a misattribution
  (those log lines were live-worker runs *without* `--no-cache`). (`graph-command-spec.ts:237,388`, `cache-orchestrator.ts:64`, `orchestrate.ts:217`, `shard-runner.ts:118`)
- **Incremental cache serving stale line numbers** — granularity is per-file; an
  edited file is always in the rebuild closure and fully re-walked, so unchanged
  files can't have shifted lines. (`incremental-merge.ts:216-239`) The only residual
  risk is the mtime+size fingerprint missing a size-preserving edit (`invalidate.ts:96-107`) — narrow, not the symptom.
- **`@graph-ignore` path-format / line-anchoring** — verified correct in all build
  modes (paths are repo-root-relative; `-next-line` resolves to directive+1; cycle
  matches any SCC member via `memberLocations`). The Rust:290 waiver that "looked
  misplaced" is actually a legitimate SCC member. (`apply-suppressions.ts:44-72`, `core/src/signals/suppress.ts:219-235`)

---

## Consolidation Plan ("consolidate as much as possible; diverge only in the renderer")

The unifying principle: there is exactly **one build → one finalize (suppression +
verdict) → many renderers**. Paths may differ in *how progress is shown* and *whether
the build runs in-process or in a worker* — never in *what is built*, *what is
waived*, or *what verdict is computed*.

### Phase 1 — kill the false warnings + make it un-regressable (this round)

1. **Single suppression+finalize seam crossed by ALL paths.** Introduce one
   `finalizeGraphSignals(signals, buildRoot)` (suppression → the deliverable signal
   set) and call it from both producers of the live path
   (`runGraphWithProgress` in `graph-runner.tsx` and `executeGraphWorker` in
   `graph-worker.ts`) as well as keeping it on `dispatchGraphResult`. The live path's
   persist/verdict/render then operate on waived signals by construction.
   - Cleanest single choke point: apply inside `buildLiveGraphOutput`
     (`graph-report.ts:51`) — both live producers funnel through it — threading the
     build root (= the live view's `cwd`). (It becomes async / does file I/O; or keep
     it pure and add an explicit `await finalizeGraphSignals(...)` step in both
     producers, mirroring `dispatchGraphResult`.)
2. **Invariant guardrail so a future 4th path can't silently regress this.** Add a
   test/invariant asserting every persisted/delivered graph signal set has passed
   through suppression (parity-invariant-index style). This is the step that makes
   the fix *stick* — the reason it kept recurring is nothing forced all paths through
   one seam.
3. **Regression test** asserting the live/TTY/worker path yields 0 findings for the
   repo's waived set (existing `dispatch-suppression-root.test.ts` only covers
   `executeGraph`).
4. **Verify both ways:** non-TTY `graph` AND `script -q /dev/null … graph` (TTY) must
   both report the SAME finding count (0 on this repo after waivers).

### Phase 2 — engine/cache determinism (separate, larger workstream)

5. **TTY selects renderer only, not engine.** Decouple "Ink live view vs plain text"
   from "single vs sharded build" (`graph-command-spec.ts:228`).
6. **Stop the sharded/single cache-row clobber.** Either partition the catalog row by
   mode/cacheKey, or derive the *same* key for both modes over identical source so
   they're interchangeable. Run the sharded key through `stampEngineVersion` at
   minimum. (`cross-shard-resolve.ts:108`, `cache-orchestrator.ts`, `schema.ts:41`)
7. **Reconcile the ~2,400-function divergence** between engines, or pin a single
   engine for the default run. A finding's existence must not depend on partition
   layout. Treat as correctness, not perf.
8. Log the chosen engine/mode at `graph.cli.graph.start` for future diagnosis.

---

## Recurrence Log

### 2026-06-09 — root cause found (TTY suppression bypass) + Phase 1 fix
- **Observed:** `graph` (in terminal) → 7 warnings (1 `large-function`, 6 `cycle`),
  all with `@graph-ignore` directives present. Session `GRAPH_01KTQ2T9G0Y4389210VTY27C1C`.
- **Found:** Defects A + B above. A is the direct cause; confirmed empirically that
  TTY vs pipe flips the path (forced-TTY → 8 warnings; piped → 0).
- **Prior attempt that didn't hold:** `743fab98` ("waive against build root, not
  opts.cwd") fixed a path-resolution leak *inside `executeGraph`*; the interactive
  terminal path bypasses `executeGraph`, so it never applied there.
- **Phase 1 — DONE, merged + pushed (`23070e91`, 2026-06-09).**
  - Fix: one `finalizeGraphSignals(rawSignals, buildRoot): FinalizedSignals` seam
    (`graph/engine/src/cli/apply-suppressions.ts`) — the ONLY producer of the
    **branded `FinalizedSignals`** type and the only place `applyGraphSuppressions`
    runs for production. All three producers cross it: static (`dispatchGraphResult`
    + multi-path in `graph.ts`), live in-process (`runGraphWithProgress` →
    `buildLiveGraphOutput`), live worker (`executeGraphWorker` → `buildLiveGraphOutput`,
    suppression runs INSIDE the worker; parent re-stamps the IPC-dropped brand via
    `assertFinalizedAcrossBoundary`).
  - **Structural guardrail:** `persistSession` accepts ONLY `FinalizedSignals`, so a
    future path handing raw `Signal[]` to persist/verdict/render **fails to compile**.
    Plus `live-suppression-parity.test.ts` (incl. a `@ts-expect-error` compile check).
  - **Parity proven (merged main):** before piped=2 / TTY=9; after **piped=2 / TTY=2**.
    Full gate green incl `test:coverage`; `fit` + graph dogfood green.
  - **7-vs-8(-vs-9) resolved:** the 7 false leaks are now suppressed on both paths.
    The 2 survivors are GENUINELY NEW, real findings from the recent authored-tool
    work (NOT silently waived): `graph:wide-function` on
    `admitAndRegisterAuthored` (`packages/cli/src/bootstrap/register-tools.ts`, 6
    params) and `graph:cycle` on `buildCompletionSpec`
    (`packages/cli/src/commands/host-command-specs.ts`, 3-fn cycle). Pending a
    refactor-vs-waive decision (tracked separately).

- **Phase 2 — DONE, merged + pushed (`10696e91`+`b0814a74`, 2026-06-09); ADR-0031 (`7319eaa3`).**
  - **Engine choice is deterministic + decoupled from TTY.** New `resolveEngineShards`
    (`graph/engine/src/cli/graph.ts`) returns shards ONLY when `--sharded` is passed
    AND the project is shardable; never reads `isTTY`. `isTTY` now selects only the
    renderer (Ink live vs static text) in `graph-command-spec.ts`.
  - **Exact single-program engine is the default; `--sharded` is the opt-in** (wired
    into spec/help/completion/flag-surface test/snapshot).
  - **Cache clobber fixed:** `stampEngineVersion(key, mode)` emits
    `eng=<v>|mode=exact|…` vs `mode=sharded`, so the two engines never overwrite each
    other's `graph_catalog` row (cross-mode = clean miss, same-mode = hit).
  - **Determinism proven (merged main):** bare `graph` piped == forced-TTY ==
    **17,820 functions, 2 findings**, stable across runs (TTY hit the cache the piped
    run wrote → confirms shared exact-mode row). `--sharded` = 15,120 functions (the
    known, now opt-in divergence). Full gate green incl `test:coverage`; `fit` +
    `graph --gate-save` green.
  - **CI:** `.github/workflows/ci.yml` graph step (`graph --gate-save --sarif`) now
    uses the exact engine — slower on cold checkout (~46s) but deterministic and
    matches local `pnpm graph`. Left unchanged deliberately (adding `--sharded` would
    re-introduce CI-vs-local divergence). Decision: accuracy/determinism over CI speed.
  - **Architecture recorded:** ADR-0031 (one build → one finalize → many renderers;
    exact default + opt-in sharding).

## Engine parity built (2026-06-09) — saga essentially closed

The `graph-sharded-exact-parity` plan was built end-to-end and pushed to main:
- **P0 diagnosis** (`09d51c0c`): gap = 197 `__fixtures__` + 116 test files dropped by
  per-package tsconfigs.
- **P1 canonical file set** (`5507548a`): both engines compute root-discovery −
  `__fixtures__` (production + real tests); gap 2,700 → 2.
- **P2+P3 equivalence** (`af856f63`): residual 2 was a real bug — merge dedup key
  missed `column`, collapsing same-line body-twins; fixed. `diffCatalogs` now spans
  function-set + edges + SCCs (reusing the cycle rule's Tarjan); medium oracle fixture
  + repo-scale `equivalence-repo-scale` guardrail in the PR gate. Gap → **0**.
- **P4 flip + ADR** (`672b5c91`): **sharded is now the default**, `--exact` is the
  opt-out, `isTTY` selects only the renderer. ADR-0032 supersedes ADR-0031. Verified:
  bare `graph` ~4s (sharded) == `--exact` ~44s == TTY, all 0 findings, catalog gap 0.
- **P4 follow-up — live-view regression fixed** (`8f1fa73e`): the flip had gated the
  Ink live progress view to `--exact` (the live runner was hardwired to the
  single-program build), so a bare interactive `graph` (sharded default) dropped to a
  bare summary with no staged checklist — violating "isTTY selects only the renderer."
  Fix: the sharded build now emits the 7 canonical progress stages, and the live view
  drives the policy-selected engine (sharded in-process — its shards are already
  subprocesses; `--exact` keeps the ADR-0028 off-process worker). Both engines now show
  the staged "Code Graph" view in a TTY, static when piped. Suppression-finalize seam
  preserved on the live path.

Net: `graph` is fast (sharded default) AND byte-exact AND deterministic AND
scale-safe, with parity enforced in CI. The two original defects (TTY suppression
bypass, ambient engine choice) plus the catalog divergence are all closed.

**Remaining manual step:** Phase 6's opensip no-OOM validation — run the new `graph`
(sharded default) on the large opensip checkout to confirm it completes without the
historical OOM/~18min, and that `--exact` there still OOMs (documents why sharded is
the default). Can't be run from the opensip-tools checkout.

## Still Open (post-Phase-1/2)

1. ~~**Two genuinely-real findings**~~ — **RESOLVED (refactored at root, no waivers;
   `7ab3fa3a`+`5cfecd12`, 2026-06-09).** `admitAndRegisterAuthored` 6 positional
   params → single `AuthoredRegisterArgs` options object; `buildCompletionSpec` cycle
   broken by extracting `buildNonCompletionHostSpecs` leaf + a static
   `COMPLETION_SELF_SPEC` descriptor. Bare `graph` now reports **0/0/0/0** on both
   piped and TTY. Full gate + fit green.
2. **Sharded ≡ exact reconciliation** (the ~2,400–2,700-function divergence) — perf
   follow-up; `--sharded` output is approximate and must not gate production code
   until closed.
3. **⚠️ opensip-SCALE RISK of exact-default.** A prior measurement (2026-06-06, see
   the `project_graph_dual_engine_divergence` memory) found the exact single-program
   engine OOM'd / ran ~18 min on the large `opensip` repo (5,675 files) — and
   cold-start on a large monorepo is the maintainer's stated #1 concern. Phase 2 made
   exact the DEFAULT, which is verified-good on opensip-tools but may be slow/failing
   on opensip. `heap-preflight` now elevates to 12 GB (>2,500 files) and re-execs,
   mitigating OOM but not the minutes-long cold build. **This was not surfaced before
   the engine-policy decision — it should be verified on opensip.** Options if it
   regresses there: (a) accept slow cold + rely on caching; (b) deterministic
   size-threshold auto-escalation to sharded for very large repos (logged, not
   TTY-based) — but that reintroduces approximate results at scale; (c) prioritize
   item 2 (make sharding byte-exact) so the fast engine becomes the safe default at
   every scale. (c) is the durable answer. **PLAN WRITTEN (2026-06-09):**
   `docs/plans/ready/graph-sharded-exact-parity/` — diagnose the function-set gap →
   unified file-set sharding → cross-shard coverage → repo-scale equivalence guardrail
   → flip default to sharded (ADR-0032 supersedes ADR-0031) → tests → validation
   (opensip no-OOM). Resolves items 2 AND 3.

## Edge-divergence reconciliation (2026-06-09/10)

A user asking why the live view said "32333 **cross-shard** call site(s)" uncovered
that the sharded and exact engines produced different *edge* sets on opensip-tools —
the "equivalence" shipped in the parity plan was function-set parity + edge/SCC parity
**only on a synthetic fixture** (the fixture adapter resolved bare specifiers straight
to source, so it structurally could not model the real `dist/*.d.ts` divergence). The
repo-scale guardrail gave false confidence.

**Investigation verdict (root-caused):** sharded (the new default) is the *more*
correct engine. EXACT (`--exact`) had TWO bugs:
- **Under-resolution:** workspace imports (`@opensip-tools/*`) resolve via Node16 to a
  package's built `dist/*.d.ts` (bodiless); the exact resolver hashed that signature →
  bodyHash ≠ source → real cross-package edge dropped (`graph-typescript/.../direct-call.ts`
  → `find-catalog-entry.ts` → `hash-body.ts`).
- **Over-resolution:** a whole-catalog same-name scan fallback fabricated phantom edges
  (`describe`→Vitest global, `getText`→`ts.Node.getText`, `cwd`→`process.cwd`). ~70% of
  exact-only edges were phantoms. Sharded declined all of these (its linker requires an
  import binding).
The earlier "~46k edge gap" alarm was overstated: ~106k of it was empty-`to` placeholder
edges, not real edges; the genuine resolved-edge difference was ~1–2k.

**Reconciliation (`dfeea8e4`):** hoisted the sharded linker's import-binding/export-index
resolution to engine core (`graph/engine/src/cross-package/`) and routed the EXACT engine
through it — fixing both bugs with one shared model (decline-beats-guess preserved).
Convergence on opensip-tools: intraMismatches 1447→231, exact phantoms 914→87,
under-resolution 1349→165, **zero new findings**, full gate + fit green. Residual is
benign + characterized: test-file owners (gate-invisible), ~56 prod re-export chains where
exact is now *more* correct than sharded's V1 linker (which declines re-exports), and JSX
positional/body-twin intra picks.

**Label fix (`17a12998`):** the resolve stage now shows engine-agnostic
"N call site(s)" (no "cross-shard"), counting **resolved** edges (`to.length>0`), not the
~106k empty-`to` placeholders that were inflating the sharded number. Post-reconciliation
default ≈ `--exact` (≈41,235 vs 39,538; the ~1.7k gap = the documented re-export residual).

### Real-repo equivalence guardrail — BUILT (2026-06-10, commit `10f6fa9c`)
The blind synthetic fixture guardrail (its adapter resolves bare specifiers straight to
source, so the engines agreed by construction — it could never model the real
`dist/.d.ts` divergence) is now backed by a REAL-repo dogfood guardrail:
- **`graph-equivalence-check` subcommand** + **`pnpm graph:equivalence:ci`** + a CI step
  ("Graph engine equivalence") after `pnpm build` (real `dist/*.d.ts` present). Builds BOTH
  engines on opensip-tools, runs `diffCatalogs`, classifies divergence by owner file, and
  **ratchets** the production resolved-edge divergence against a committed budget
  (`.config/graph-equivalence-budget.json`). `functionsOnly` must be 0 (hard fail);
  test/fixture-owned divergences are excluded as benign (gate-invisible).
- **Regression-catch proven:** temporarily reintroducing the `dist/.d.ts` under-resolution
  spiked production divergence 204 → 359 → guardrail FAILED (exit 1). The class of bug that
  silently shipped before is now caught.
- The synthetic fixture tests stay as fast PR-gate sanity checks; their headers now state
  they do NOT exercise real `dist/.d.ts` resolution and point to this guardrail.

### ⚠️ KEY FINDING the guardrail surfaced — engines are NOT byte-equivalent on real code
The committed budget is **204 production resolved-edge divergences + 3 SCC** (functionsOnly
= 0; exact = sharded = 17,462 functions). The earlier "~56 re-export" estimate was far low.
Breakdown of the 204:
- **110 — exact UNDER-resolves cross-package PROPERTY/METHOD calls** (`logger.info(...)`,
  registry methods on imported objects) that sharded resolves. **NOT fixed by the
  reconciliation** (`dfeea8e4`), which only fixed direct `import { fn }` calls hitting
  `dist/.d.ts`. This is the dominant residual and the real open bug.
- **81 — sharded declines cross-package RE-EXPORT chains** (exact is more correct here).
- **13 — genuine target disagreement.**
(Plus ~1,613 unresolved-vs-absent *structural* diffs, informational; SCC 3.)
So sharded (the default) remains the more-correct engine; `--exact` still under-resolves
property-access cross-package calls. The guardrail MEASURES + LOCKS this state (catches any
worsening) — it is a ratchet on an imperfect baseline, not a proof of equivalence.

### Still open from this episode
- **Exact property-access cross-package under-resolution (the 110).** The dominant residual.
  A property/method call on an imported object whose type resolves into a workspace
  `dist/*.d.ts` doesn't link to the source occurrence. The same `dist/.d.ts`→source repoint
  the direct-call path got (`resolve-decl.ts`) needs extending to the property-access /
  method-call resolvers. Larger than the direct-call fix; drives the budget toward 0.
- **Sharded re-export handling (the 81).** Sharded's V1 boundary linker declines re-export
  chains (`childrenOf`/`nameOf` re-exported by `graph-adapter-common` from `tree-sitter`)
  where exact is more correct. Teaching the linker to follow re-exports closes this class.
- **Sharded empty-`to` placeholder edges (~106k).** Noise in the persisted catalog (one
  per unresolved cross-shard call site). Harmless to findings (no target) but inflates the
  catalog/datastore and the raw edge count; worth pruning before persist.
- As the 110 + 81 are fixed, **tighten `.config/graph-equivalence-budget.json` toward 0**.

### 2026-06-11 — convergence (204 → 12) + directional guardrail (ADR-0033)
- **Observed:** the `graph-resolution-correctness` plan executed the
  direction-of-travel above; production resolved-edge divergence 204 → **12**.
- **Found / Changed:** the root cause of the ill-posed flat ratchet was that the
  two engines ran **different resolution models**. Fixed by converging onto ONE
  shared hop — the exact build now recovers cross-package edges via the SAME
  post-merge linker the sharded build runs (`cache-orchestrator.recoverExactBoundaryEdges`,
  exact = the 1-shard case). Plus: `buildExportIndex` re-export chains (closed the
  81 class in BOTH engines); sharded JSX double-emission dedup (the 36); file+name
  pin with unique-or-decline (identical semantics in both engines); declined
  parameter/callback name-guesses. Commits 8ac3b167 (Phase 3) + this Phase 4.
- **The 110 re-examined:** exact property/method under-resolution is now mostly
  recovered through the shared boundary linker. The 12 residual = **1 phantom**
  (exact under-resolves `scope.graph?.rules.getAll()` through an optional chain —
  sharded is correct), **0 decline**, **11 conflict** (cross-package same-name
  registry-method mis-narrowing — both engines pick different occurrences; the real
  open bug, tracked).
- **Guardrail inverted (ADR-0033, supersedes ADR-0032):** the flat
  `productionResolvedEdgeDivergences` budget became a **directional** ratchet
  (phantom / decline / conflict, each floored, gated per-direction) + a pinned-
  corpus **completeness floor** (`resolution-completeness-floor.test.ts`, floor=7)
  for the both-engine-decline blind spot (the `logger.info()` arrow-property class).
- **Verified:** `graph-equivalence-check` PASS (phantom=1, decline=0, conflict=11,
  scc=0); full `pnpm test:coverage` + `graph`/`fit` dogfood + lint + typecheck +
  `docs:check` green.

### 2026-06-11 (later) — the "conflict 11" was MISDIAGNOSED; root-caused + fixed (12 → 1)
- **Observed:** the follow-up diagnosis mapped each of the 12 divergent sites' target
  hashes to their source occurrences (via the persisted catalog), instead of trusting
  the "same-name registry-method" label.
- **Found:** every one of the 11 conflicts is a **chained-call position collision**.
  For `recv(...).method(...)` the inner CallExpression `recv()` and the outer
  `recv().method()` BOTH start at `recv`, so an edge keyed by the expression-start
  `(owner,line,column)` collapses two REAL distinct edges onto one identity — exact
  kept the innermost (e.g. `currentRulesRegistry`, `new CatalogRepo`), sharded kept
  the outermost (`getAll`, `loadCatalogContract`). NOT same-name disambiguation; the
  same family as Phase 0.2. (Ground-truth table: registry.ts:115
  `currentRulesRegistry().getAll()`; tool.ts:215 `new CatalogRepo(ds).loadCatalogContract()`;
  check-loader.ts:56 `currentCheckRegistry().listEnabled()`; define-check.ts:156
  `ResultBuilder.create({…})…`; loader.ts:49 `currentSimulationRecipeRegistry().register(…)`.)
- **Changed:** anchor a call edge at its CALLEE token via `calleeAnchorNode`
  (graph-typescript/src/edge-resolvers/syntactic.ts), used by BOTH `tsPosition`
  (in-shard/exact) and `positionOf` (cross-shard). Every call in a chain now gets a
  distinct column → both real edges survive in both engines → agreement, and the
  previously-shadowed edges are RECOVERED (a completeness gain). Regression test
  `callee-anchor.test.ts`.
- **Verified:** `graph-equivalence-check` total 12 → **1** (phantom=1, decline=0,
  conflict **11 → 0**); budget floor tightened to `conflictDivergences:0`; 768+330
  graph tests green; graph+fit dogfood 0; completeness floor still ≥7.

### 2026-06-11 (later still) — the last phantom fixed; production divergence 1 → 0
- **Observed:** GRAPH_SITE_LOG showed exact declining `getAll` at dashboard-data.ts:44
  with `decl=packages/graph/engine/dist/rules/registry.d.ts dts=true spec=-
  out=DECLINE-dts-hop` — the receiver type flows through `ToolScope` to the graph
  package's OWN published `.d.ts`, and the `.d.ts` branch is binding-required (a
  method call has no import binding). It was NOT an optional-chain bug as first
  guessed: sharded "resolved" it only via the UNSOUND shard-scoped
  `resolveByCatalogFallback` (resolves a name unique *within the shard's catalog*;
  `getAll` is unique in the graph shard but ambiguous repo-wide → exact correctly
  declined, sharded got lucky).
- **Changed:** `pinByDtsDeclSource` (resolve-decl.ts) maps a checker-attested
  `dist/*.d.ts` method decl → its SOURCE file and pins by (file + name),
  type-anchored + catalog-scope-independent so both engines agree. RESTRICTED to
  INTRA-package targets — an unrestricted pin made exact resolve 530 cross-package
  method calls sharded can't reach (target in another shard; not a boundary call)
  → measured 530 exact-only declines; the intra-package gate keeps it symmetric.
- **Verified:** `graph-equivalence-check` total **1 → 0** (phantom=0, decline=0,
  conflict=0, scc=0); budget floors ALL 0; 768+333 graph tests, full test:coverage
  64/64, graph+fit dogfood, lint, typecheck, docs:check green; completeness floor
  holds. Regression test in `resolve-decl.test.ts`.

### 2026-06-11 (later still) — cross-package METHOD resolution (completeness gain, divergence stays 0)
- **Done:** the deferred cross-package method class now resolves through the
  boundary linker in BOTH engines. A `recv.m()` the in-shard pass leaves
  unresolved is emitted as a TYPE-attested boundary call carrying `targetFile`
  (the checker's `m` decl in a workspace `dist/*.d.ts` mapped to source —
  `methodTargetFile`, exact tier); the linker's `method-target` branch pins by
  (targetFile + name) post-merge, unique-or-decline. Exact still declines them
  inline (the intra-package pin restriction), so both route through the linker →
  symmetric. ~185 edges now resolved (incl. part of the `logger.info()` class),
  ~208 decline; divergence stays 0. Tests: `method-target.test.ts` +
  `cross-shard-resolve.test.ts` (method-target cases). ADR-0033 amendment #3.

### 2026-06-11 — the method-target declines are CORRECT (diagnosed, not a gap)
- **Diagnosed** the ~208 cross-package method declines (env `GRAPH_MT_DIAG`,
  categorizing each decline by inFile/distinct/name-anywhere counts): **~229
  NOTINFILE** = the checker attests the method to an INTERFACE/type signature
  (e.g. `ToolCliContext.setExitCode`/`render`/`emitJson` in `core/src/tools/types.ts`,
  `DataStore.close` in `data-store.ts`) — an interface method has no function body,
  so no occurrence and no unique CONCRETE target = polymorphic dispatch; **~10
  AMBIG** = genuine same-name ambiguity in the target file (`pluginsDir` get/set);
  **~4 NONAME** = no occurrence anywhere. ALL are correct unique-or-decline
  outcomes — there is no single semantic target to link. Resolving the NOTINFILE
  class would need cross-package POLYMORPHIC dispatch (link to every implementor =
  multi-target fan-out) — a separate, larger feature of debatable value, NOT a
  resolver gap. Cross-package method resolution is therefore COMPLETE for concrete
  unique targets.

### Still open after 2026-06-11
- **Production divergence is 0.** The differential guardrail is now the true
  zero-divergence soundness invariant (all directional floors 0).
- **Cross-package POLYMORPHIC (interface-method) dispatch** — the only remaining
  cross-package call class, deliberately declined (no unique target; would be
  multi-target fan-out). A separate feature if ever wanted. Symmetric, guarded by
  the completeness floor.
- **Clean-checkout parity for WORKSPACE imports.** Exact still reaches the linker
  via the dep's built `dist/*.d.ts`; relative imports are clean-safe (file+name
  pin). Source-as-surface program change deferred.

### <next occurrence> — template
- **Observed:** _(command, TTY or pipe, count, session id)_
- **Found:** _(which defect / new mechanism; file:line)_
- **Changed:** _(commits)_
- **Verified:** _(both TTY and piped runs; counts)_
