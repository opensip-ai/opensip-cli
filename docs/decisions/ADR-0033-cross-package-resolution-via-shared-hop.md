---
status: active
last_verified: 2026-06-11
owner: opensip-tools
---

# ADR-0033: Cross-package resolution via one shared hop; directional soundness invariant + completeness floor

```yaml
id: ADR-0033
title: Cross-package resolution via one shared hop; directional soundness invariant + completeness floor
date: 2026-06-11
status: active
supersedes: [ADR-0032]
superseded_by: null
related: [ADR-0003, ADR-0010, ADR-0014, ADR-0015, ADR-0031]
tags: [graph, resolution, determinism, cache, ci]
enforcement: mechanizable
enforcement-reason: >
  The resolution model is held by THREE layers. (1) The DIRECTIONAL real-repo
  guardrail `graph-equivalence-check` (CI, every PR): builds this repo through
  both engines and gates `.config/graph-equivalence-budget.json` per DIRECTION —
  phantom (sharded-only), decline (exact-only), conflict (both resolve to
  different targets) — each ratcheted to its measured floor, plus
  `functionsOnly{Exact,Sharded}` and structural=invariants; gating per-direction
  so a fixed conflict cannot mask a new phantom. (2) The pinned-corpus
  COMPLETENESS floor `resolution-completeness-floor.test.ts`: asserts a
  non-decreasing count of resolved cross-package edges on the committed
  `medium-pkg` fixture (fixed denominator ⇒ a count floor is a resolution-rate
  floor), catching a both-engine drop the differential gate is blind to. (3) The
  byte-equivalence fixture suite (`equivalence-repo-scale.test.ts`) and the
  no-bodyhash-keying / ownerEdgeKey identity tests (ADR-0003). Engine-selection
  policy and cache stamping carry forward from ADR-0032 / ADR-0015.
```

**Decision:** Cross-package call edges resolve through **one shared hop** used by
*both* engines — the `resolve-decl` declaration→bodyHash seam plus the
`export-index` `resolveCrossPackageCall`/`resolveCrossBoundaryCalls` linker. The
single-program (**exact**) build is treated as the **1-shard case**: after its
type-checker-driven inline pass, it runs the *same* post-merge boundary linker
the **sharded** build runs, so the two engines compute cross-package edges by one
model rather than two. Consequently the equivalence guardrail is redefined: it no
longer tolerates a flat "budget toward zero" but enforces a **directional
soundness invariant** — *any new divergence on the unified model fails*, each
direction (phantom / decline / conflict) ratcheted to its documented residual —
backed by a **resolution-completeness floor** on a pinned corpus. Neither engine
is the oracle; **direction is a diagnostic** ("which bound is insufficient"), not
a verdict of wrongness. The ADR-0032 default-engine policy (sharded is the
default; `--exact` is the opt-out; `isTTY` selects only the renderer; the cache
key carries `mode=exact|sharded`) **carries forward unchanged**.

**Alternatives:**
- *Keep ADR-0032's flat budget ratcheting toward 0 (`productionResolvedEdgeDivergences`).*
  Rejected: it presumed every divergence would shrink to zero with the "phantom =
  sharded-only" class eliminated. Measurement falsified that — a sharded-only edge
  is frequently a *correct* edge the type checker under-resolves (e.g.
  `scope.graph?.rules.getAll()` through an optional chain), so "direction =
  wrongness" is not a sound proxy once neither engine is the oracle. A flat total
  also lets a fixed conflict mask a new phantom.
- *A directional "phantom = 0, hard" gate (the pre-measurement plan).* Rejected:
  driving sharded-only to zero would delete real edges exact misses. Phantom is
  ratcheted to its measured floor (currently 1, documented), not forced to zero.
- *A new bounded-`ts.Program` resolution adapter + augmentation census (the
  Phase-1 "soundness spike").* Rejected/retired by the Task-0.4 diagnosis: the
  fix was bounded corrections to the shared hop (re-export chains; file+name pin
  with unique-or-decline; declining parameter/callback name-guesses) plus engine
  convergence — not a new capability surface.
- *Keep two independent resolution paths and diff them.* Rejected: that is the
  pre-convergence state where "the engines disagree" is undecidable without ground
  truth. One shared hop makes any disagreement mechanically a bug.

**Rationale:** ADR-0032's 2026-06-10 amendment recorded a 204-edge budgeted
residual and a direction-of-travel ("eliminate phantom classes, ratchet toward
the re-export class"). Executing that (the `graph-resolution-correctness` plan)
drove the residual 204 → 12 and, critically, revealed *why* a flat ratchet toward
zero was ill-posed: the two engines were running *different* resolution models, so
some divergences were exact under-resolving and some were sharded mis-narrowing —
no single number, and no directional sign, encodes "wrong." The cure was to make
both engines run **one** model (exact recovers cross-package edges via the sharded
linker — `cache-orchestrator.recoverExactBoundaryEdges`), after which a divergence
is mechanically a real bug, classified by direction for diagnosis. The remaining
12 are documented classes: 1 phantom (exact under-resolves an optional-chain
property access — sharded is correct), 0 decline, 11 conflict (cross-package
same-name registry-method mis-narrowing — a real disambiguation gap, tracked for
follow-up). A separate blind spot — sites both engines decline (e.g.
arrow-property `logger.info()`) — is invisible to a differential gate by
construction, so it is guarded by the pinned-corpus completeness floor.

**Consequences:**
- `.config/graph-equivalence-budget.json` changes shape: `{ phantomDivergences,
  declineDivergences, conflictDivergences, sccDivergences }` (per-direction
  floors) replaces the single `productionResolvedEdgeDivergences`. `--update-budget`
  writes the new shape.
- `graph-equivalence-check` output now reports the directional breakdown every run
  and fails on a per-direction breach (printing only the breached direction's
  offenders).
- A new CI-relevant test, `resolution-completeness-floor.test.ts`, ratchets the
  resolved cross-package edge count on `medium-pkg` (floor = 7). Adding resolved
  edges to the fixture requires raising the floor.
- The exact engine emits syntactic boundary calls (`emitBoundaryCalls`) and runs
  the cross-shard linker in `obtainCatalog`; a debug-only `GRAPH_SITE_LOG` trace
  harness (isolated, env-gated) is retained for the next investigation
  (`docs/internal/graph-resolution-trace.md`).
- **Build-state independence is partial and explicit:** the file+name pin made
  RELATIVE/intra-package imports clean-checkout-safe in both engines; WORKSPACE
  `@scope/pkg` imports still reach the linker in exact via the dep's built
  `dist/*.d.ts`, so a `rm -rf packages/*/dist` still drops those edges in exact
  (sharded's syntactic extractor is dist-independent). The source-as-surface
  program change is deferred to a follow-up; the clean-checkout assertion is
  scoped to the relative class accordingly.
- ADR-0032 is **superseded**; its default-engine policy is restated here and
  remains in force. ADR-0031's suppression seam / `FinalizedSignals` /
  renderer-by-TTY / `mode=` cache stamping remain unchanged.

**Related specs / ADRs:** Supersedes ADR-0032 (sharded default), carrying its
engine-selection policy forward. Builds on ADR-0003 (ownerEdgeKey occurrence
identity — body-twins must not union edges), ADR-0010 (cross-package export
model), ADR-0014 (shared inline-suppression primitive), ADR-0015 (engine-version +
mode cache stamping), ADR-0031 (one build / one finalize / many renderers).
Implements the `graph-resolution-correctness` plan (local). Residual diagnosis +
the `GRAPH_SITE_LOG` harness recorded in
`docs/internal/graph-resolution-trace.md` and
`docs/internal/graph-false-findings-incident-log.md`.

**Amendment (2026-06-11) — the "conflict" class was MISDIAGNOSED; re-diagnosed +
fixed (divergence 12 → 1).** This ADR's body calls the 11 conflicts
"cross-package same-name registry-method mis-narrowing." Measurement (mapping each
divergent site's target hash to its source occurrence) **falsified that**: every
one was a **chained-call position collision**. For `recv(...).method(...)` the
inner CallExpression `recv()` and the outer CallExpression `recv().method()` BOTH
start at `recv`, so a call edge keyed by the expression-start `(owner, line,
column)` collapses two *real, distinct* edges onto one identity — and the exact
and sharded engines each kept a different member (exact the innermost, sharded the
outermost). It was never a same-name disambiguation problem; it is the same family
as Phase 0.2 (column-misaligned duplicates). **Fix:** anchor a call edge at its
CALLEE token (method name / class / callee identifier) via `calleeAnchorNode`
(`graph-typescript/src/edge-resolvers/syntactic.ts`), used by BOTH `tsPosition`
(in-shard/exact) and `positionOf` (cross-shard) so the engines stay consistent and
both real edges survive at distinct columns. Result: conflict 11 → 0 (and the
previously-shadowed edges are recovered — a completeness gain). The directional
guardrail is unchanged; only the budget floor tightens to `conflictDivergences:0`.
**Remaining residual = 1 phantom** (the `dashboard-data.ts:44`
`scope.graph?.rules.getAll()` optional-chain method call exact under-resolves) —
the genuine, separate exact-resolver gap, tracked.

**Amendment (2026-06-11, #2) — the last phantom fixed; production divergence 1 →
0.** Diagnosis (GRAPH_SITE_LOG): exact's type checker attributes
`scope.graph?.rules`'s `getAll` to the graph package's own published
`dist/rules/registry.d.ts` (the receiver type flows through `ToolScope`), and the
`.d.ts` branch is binding-required — a METHOD call has no import binding, so it
declined. Sharded "resolved" it only by an UNSOUND shard-scoped fallback
(`resolveByCatalogFallback` resolves a name that is unique *within the shard's
catalog*; `getAll` is unique in the graph shard but ambiguous repo-wide, so exact
correctly declined while sharded got lucky). **Fix:** `pinByDtsDeclSource`
(`resolve-decl.ts`) maps a checker-attested `dist/*.d.ts` method decl to its
SOURCE file (tsc `outDir:dist`/`rootDir:src`) and pins by (source file + name),
unique-or-decline — type-anchored, catalog-scope-INDEPENDENT, so both engines
resolve identically. **Restricted to INTRA-package targets**: an unrestricted pin
made exact resolve 530 CROSS-package method calls the sharded in-shard pass cannot
reach (target in another shard; method calls carry no import binding so they don't
ride the cross-shard boundary linker) → 530 exact-only declines. Intra-package
targets are in-shard for both engines → symmetric. Cross-package method resolution
remains the separate, larger completeness item (guarded by the resolution-
completeness floor), left declined in BOTH engines. Result: **all directional
floors are now 0** — the guardrail is the true zero-divergence soundness
invariant. Regression test in `resolve-decl.test.ts`.

**Amendment (2026-06-11, #3) — cross-package METHOD resolution (a completeness
gain, divergence stays 0).** The cross-package method class deferred in amendment
#2 is now resolved through the boundary linker — the SAME place cross-package
FUNCTIONS resolve — in both engines. Mechanism: a method call `recv.m()` the
in-shard/inline pass leaves unresolved is emitted as a **type-attested boundary
call** carrying `CrossBoundaryCall.targetFile` — the checker's `m` decl in a
workspace `dist/*.d.ts` mapped to its source (`methodTargetFile`, supplied by the
adapter from the `ts.Program`; exact tier only). The linker's new `method-target`
branch (`resolveOne`) pins by (`targetFile` + `calleeName`) against the merged
catalog, unique-or-decline. Exact's inline pass still declines cross-package
methods (the intra-package pin restriction from #2), so BOTH engines route them
through the linker → symmetric. Measured on this repo: ~185 cross-package method
edges now resolved (incl. part of the `logger.info()` arrow-property class), ~208
decline, divergence stays **0**. The declines are CORRECT (diagnosed via
`GRAPH_MT_DIAG`): dominantly INTERFACE/POLYMORPHIC dispatch — the checker attests
the method to an interface/type signature (`ToolCliContext.setExitCode`,
`DataStore.close`) with no function body, hence no unique concrete target — plus
genuine same-name ambiguity and names with no occurrence. Resolving the
interface class would require cross-package POLYMORPHIC dispatch (multi-target
fan-out to every implementor), a separate larger feature, out of scope. So
cross-package method resolution is COMPLETE for concrete unique targets.
Regression tests: `method-target.test.ts` (the resolver) + the `method-target`
cases in `cross-shard-resolve.test.ts` (the linker pin).
