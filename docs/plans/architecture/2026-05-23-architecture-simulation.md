---
status: current
last_verified: 2026-05-23
title: "Architecture audit (delta) — @opensip-tools/simulation"
package: "@opensip-tools/simulation"
audience: [contributors, architects]
prior-audit: ./2026-05-22-architecture-simulation.md
remediation-plan: ./2026-05-22-plan-layer-3-tools-and-lang.md
---
# Architecture audit (delta) — @opensip-tools/simulation

Delta audit re-verifying the 2026-05-22 findings after Waves 1–4 of the
Layer 3 remediation plan (Group E specifically) landed. The package is
in materially better shape than 24 hours ago: every P0/P1 architectural
finding from the prior audit is closed, and no regressions were
introduced. A small handful of net-new items surfaced — all P2/P3 —
plus three items the prior audit missed.

## Prior-finding status

| # | Title | Prior severity | Status |
|---|---|---|---|
| 1 | `runWindow` duplicates the load executor's loop body | P1 | **CLOSED** |
| 2 | Two parallel `getMetricValue` implementations | P1 | **CLOSED** |
| 3 | Per-kind `validateXxxScenarioConfig` boilerplate | P2 | **CLOSED** |
| 4 | Misleading "dispatcher switch" diagram in execution-model docs | P3 | **OPEN** (out of scope: docs not code) |
| 5 | `_exhaustive: never` exists at one site only / open-coded `SCENARIO_KINDS` | P2 | **CLOSED** |
| 6 | Invariant-driver Strategy stubs well-shaped | (informational) | **CLOSED — no action required** |
| 7 | Predicate registry well-shaped with one ergonomic gap | (informational) | **OPEN** (deferred per remediation plan §Deferred) |
| 8 | Chaos kind composes load via copy, not Strategy | P2 | **CLOSED** structurally; doc reconciliation deferred |
| 9 | `simulation/recipes` and `fitness/recipes` share intent but not code | P2 | **CLOSED** |
| 10 | `Signal.source = 'simulation'` accurate | (informational) | **OPEN** (deferred — doc-only) |
| 11 | Primitive obsession in `ScenarioAssertion.metric: string` | P2 | **CLOSED** |
| 12 | `RunnableScenario.tags` is `readonly string[]`, never typed | P3 | **OPEN** (deliberately deferred — open vocabulary) |
| 13 | `defineXxxScenarioWithoutRegistration` family validation drift | P2 | **CLOSED** |

### Verification notes

**F1 — `runWindow` duplication closed.** `framework/execution/run-load-window.ts:162-206`
is the canonical Template Method. Both kind executors delegate cleanly:
`kinds/load/executor.ts:45-47` (no `injectChaos`) and
`kinds/chaos/executor.ts:104-121` (chaos passes an `injectChaos`
callback that wraps `tickStartMs` into the event payload). Tick-loop
constants (`TICK_INTERVAL_MS`, 95% baseline success) live once.

**F2 — Metric resolution unified.** `framework/resolve-metric.ts` is a
single 184-line module with comprehensive JSDoc; the
`success_rate`-on-empty disagreement is explicitly resolved (chose
`0`) with rationale documented at lines 51-63. Both
`framework/result-builder.ts:168` and
`framework/execution/execution-engine.ts:153` delegate to it. The
`METRIC_FIELD_MAP` constant is gone. The `default: 0` silent-fail
path is now compile-time-unreachable because `ScenarioMetricKey`
narrows the input.

**F3 — Validation deduped.** `framework/validation.ts` exports
`validateScenarioMetadata`, `validateScenarioUniqueness`, and
`throwValidationErrors`. All four kinds consume them
(`kinds/load/define.ts:133,146,150`;
`kinds/chaos/define.ts:146,150,154`;
`kinds/invariant/define.ts:96,98,102`;
`kinds/fix-evaluation/define.ts:244,249,253`).
`ScenarioValidationError` is the canonical type; the four legacy
per-kind aliases (`LoadValidationError`, etc.) are JSDoc-deprecated.

**F5 — `SCENARIO_KINDS` is the single source.**
`recipes/types.ts:36-40` types
`KindScenarioSelector.kinds: readonly ScenarioKind[]`;
`cli/sim.ts:23` is `new Set<ScenarioKind>(SCENARIO_KINDS)`. Adding a
new kind is a one-touch addition to `types/kind-types.ts:20-28` plus
the four compile-time-enforced sites.

**F8 — Chaos via composition (structurally).** Chaos no longer copies
the load loop body; it composes `runLoadWindow` twice (steady +
recovery windows) with kind-specific `injectChaos` and post-window
verdict synthesis. The architectural shape now matches the
documentation in spirit even though the public `ChaosScenarioConfig`
still flattens load fields rather than embedding a
`baseLoad: LoadScenarioConfig`. Doc reconciliation (option (b) of the
prior audit's recommendation) is the remaining task and is plan-
deferred.

**F9 — `RecipeRegistry<T>` promoted.** `packages/core/src/recipes/registry.ts`
ships the parameterised registry (187 lines, well-documented duplicate
policy: warn-and-skip vs throw-on-duplicate vs allow-overwrite).
`packages/simulation/engine/src/recipes/registry.ts:26` is now a 75-line
subclass that adds `BUILT_IN_NAMES`, `listForDisplay`, and built-in
re-registration on `reset()` — all genuinely sim-specific.

**F11 — `ScenarioAssertion.metric` typed.** `types/base-types.ts:81`
imports `ScenarioMetricKey` from `framework/resolve-metric.js` and
types the field as that union. A typo like `'p99-latnecy'` is now a
TypeScript error at the call site.

**F13 — `WithoutRegistration` family unified.** All four kinds
(`load:191`, `chaos:177`, `invariant:125`, `fix-evaluation:278`) now
call the same validator with `{ skipRegistryCheck: true }`. Test
helpers go through the same gate as production validators — closing
the masking-validation-regression risk the prior audit flagged.

## Net-new findings

### F-N1 — `framework/execution/execution-engine.ts` is 659 lines and houses two parallel models

- **Severity:** P2.
- **Where:** `packages/simulation/engine/src/framework/execution/execution-engine.ts:1-660`.
- **What:** The file mixes the new `ScenarioExecutionContext` model
  (used by load/chaos via `runLoadWindow`) with the legacy
  `ExecutorContext` / `ScenarioExecutor` / `createScenario` /
  `createStandardExecutor` / `runSimulationLoop` model (no current
  caller in the runtime path; only re-exported through `index.ts`).
  The `validateAssertions` function (now correctly delegating to
  `resolveMetric`) is the only piece both worlds use. The legacy
  surface is ~410 of the file's 659 lines (lines 38-133, 222-660).
- **Why it matters:** Two discoverable patterns for the same job. A
  contributor reading `index.ts:198-206` sees both `runSimulationLoop`
  and `runLoadWindow` exported as if equivalent; in reality only
  `runLoadWindow` is wired into the new kinds. The legacy export still
  pulls in `ExecutorContext`, `StandardExecutorConfig`, and friends —
  none of which any kind constructs. `@fitness-ignore-file
  file-length-limits` at line 1 papers over the size, but the size
  isn't the point — the divergence between the two models is.
- **Recommendation:** The prior audit's "Non-findings dismissed"
  section already acknowledged this (`createScenario` /
  `createStandardExecutor` survive because `framework-types.ts` still
  references `CustomExecuteFn` and the legacy alias path uses them
  indirectly). Now that Wave 4 unified the new path, this is the right
  time to schedule the legacy rip-out. Three steps: (a) delete
  `defineScenario` (already deprecated, gives one-release notice), (b)
  delete `createScenario` / `createStandardExecutor` /
  `runSimulationLoop` / `ExecutorContext` / `ExecutorScenarioConfig` /
  `StandardExecutorConfig` from this file, (c) delete the
  `@fitness-ignore-file file-length-limits` directive — without the
  legacy half the file should drop to ~250 lines. None of this is
  P0/P1 because nothing is broken; the cost is purely contributor
  confusion.

### F-N2 — `framework/generic-registry.ts` is now redundant with `core`'s `RecipeRegistry<T>`

- **Severity:** P3.
- **Where:** `packages/simulation/engine/src/framework/generic-registry.ts:1-64`;
  used at `framework/registry.ts:15`
  (`new GenericRegistry<RunnableScenario>(...)`).
- **What:** The file's leading comment self-documents as "Copied from
  @opensip-tools/core registry for standalone use." After Wave 4's
  Phase E3, core ships a parameterised registry (`RecipeRegistry<T>`)
  with strictly broader semantics: silent-skip + warn-and-skip + throw
  + allow-overwrite, all configurable. `GenericRegistry` does only
  silent-skip on duplicate id with a hard throw on
  conflicting-name-different-id (line 30). The two registries now
  live side by side in simulation; the local one is a one-pattern
  subset.
- **Why it matters:** After paying down the registry duplication
  between simulation and fitness (the prior audit's F8), the
  *intra-package* registry duplication remains. A scenario registry is
  not a recipe registry — `RecipeRegistry<T>` requires
  `displayName`/`description` which scenarios don't carry — so
  `RecipeRegistry<T>` isn't a drop-in replacement. But the underlying
  dual-key + tag-filter shape is the same one core already exposes via
  `LanguageRegistry`/`ToolRegistry` (per the kernel pattern Layer 1
  promoted).
- **Recommendation:** Either (a) extract a smaller
  `IdNameTagRegistry<T extends Registerable>` into core as the
  "common ancestor" of `LanguageRegistry`, `ToolRegistry`, and the
  scenario registry — duplicate-policy parameterised the same way
  `RecipeRegistry<T>` does — and have both fitness and simulation
  consume it; or (b) document the deliberate divergence explicitly
  ("scenarios use silent-skip because the sim-loader-test pattern
  re-registers the same id many times"). Option (a) is the
  consistency-pass move; option (b) is the cheaper near-term answer.
  Pair this with the F-N1 cleanup if it lands.

### F-N3 — `LoadWindowEvent` and `ChaosEvent` are structurally identical but live in two files

- **Severity:** P3.
- **Where:** `framework/execution/run-load-window.ts:27-31`
  (`LoadWindowEvent`); `kinds/chaos/result.ts:19-23` (`ChaosEvent`);
  cast at `kinds/chaos/executor.ts:143-146` ("structural compatibility
  is documented in run-load-window.ts").
- **What:** The chaos executor casts
  `readonly LoadWindowEvent[] as ChaosEvent[]` because the framework
  (correctly, per layering) cannot import from a kind subtree, and the
  `ChaosEvent.type` is a 6-member literal union while the framework's
  `LoadWindowEvent.type` is `string`. The type-level relationship is
  "ChaosEvent is a tighter LoadWindowEvent" but encoded only in the
  cast.
- **Why it matters:** A future chaos `type` value the framework
  doesn't know about (extending the literal union) silently passes the
  cast. The runtime invariant is currently held by virtue of
  `kinds/chaos/executor.ts:48-52` populating only from
  `config.chaos.types[0].type` — which is well-typed `ChaosType` —
  but the boundary is implicit. A second consumer of `runLoadWindow`
  (e.g. a future load-recovery-window-without-chaos) might emit
  arbitrary string `type`s and the chaos cast would silently accept
  them.
- **Recommendation:** Make `LoadWindowEvent` generic in its `type`
  parameter:
  `interface LoadWindowEvent<T extends string = string> { readonly type: T; ... }`
  and have `runLoadWindow` accept the type parameter through
  `RunLoadWindowOptions`. Then chaos calls
  `runLoadWindow<ChaosType>(...)` and the boundary is type-safe with
  no cast. Alternative (cheaper): tighten the comment at
  `chaos/executor.ts:139-142` to call out the runtime invariant
  explicitly and add a unit test that asserts every emitted event's
  `type` parses as a valid `ChaosType`.

### F-N4 — `runLoadWindow.signals` is always empty

- **Severity:** P3.
- **Where:** `framework/execution/run-load-window.ts:171,203,205`.
- **What:** `runLoadWindow` constructs `signals: Signal[] = []`,
  computes `metrics.findingsGenerated = signals.length` against an
  always-empty array, and returns the empty array in
  `LoadWindowResult.signals`. Neither the load nor the chaos kind
  emits signals during the loop today; the field is reserved future
  surface.
- **Why it matters:** `findingsGenerated` is therefore always `0` in
  any load- or chaos-kind run, and an assertion on
  `findings_generated` (a registered metric in `resolveMetric`)
  silently always evaluates against `0`. The reserved-key behavior
  documented in `resolve-metric.ts:36-48` exists for keys without
  underlying fields (`max_latency_ms`, `memory_mb`, `cpu_percent`);
  `findings_generated` has the field but no producer. It's a different
  kind of unwired-by-design.
- **Recommendation:** Either (a) drop the `signals` slot from
  `LoadWindowResult` until a real producer wires it (chaos/load don't
  need it today; the kind executors already assemble their own
  `signals: Object.freeze([...])`), and let
  `findingsGenerated` get populated when a producer arrives; or
  (b) document the reserved-but-unwired status of `signals` in
  `runLoadWindow`'s JSDoc the same way `resolve-metric.ts` documents
  `max_latency_ms`. Option (a) is cleaner (YAGNI — the framework
  doesn't ship a producer); option (b) preserves the future-extension
  surface.

## Findings the prior audit missed

### F-M1 — `ChaosScenarioConfig.execute` is declared but never honored

- **Severity:** P2 (correctness latent, not currently triggered).
- **Where:** `kinds/chaos/define.ts:59` declares
  `readonly execute?: CustomExecuteFn`; `kinds/chaos/executor.ts`
  never reads it. (Compare to `kinds/load/executor.ts:113` which
  branches on `config.execute` to pick between
  `createCustomExecutor` and `createStandardExecutor`.)
- **What:** A chaos author can pass `execute: someFn` and it's
  silently ignored — the chaos runner always uses the standard
  `runLoadWindow`-driven executor. The validator
  (`validateChaosScenarioConfig`) doesn't even reject the unused
  field.
- **Why it matters:** This is the surface of the prior audit's F8
  ("chaos kind composes load via copy, not Strategy") that wasn't
  fully addressed by the Wave 4 refactor. The structural copy is
  gone (good); the *config-shape* copy survives, including a field
  that has no implementation.
- **Recommendation:** Either (a) drop `execute` from
  `ChaosScenarioConfig` (cleanest — chaos is fundamentally
  framework-driven; a custom-execute escape hatch undermines the
  injection model), or (b) plumb it through
  `createChaosScenarioRunner` similarly to load. Option (a) with a
  validator error on `execute` set is the recommended call. Pair this
  with F8's deferred doc reconciliation.

### F-M2 — `LoadScenarioConfig.options` (and `ChaosScenarioConfig.options`) is read by no one

- **Severity:** P3.
- **Where:** `kinds/load/define.ts:56`, `kinds/chaos/define.ts:62`
  (both declare `readonly options?: ScenarioExecutionOptions` —
  `persistReports`, `persistLogs`); no executor or runner reads them.
- **What:** Authors can configure `persistReports: true` on a load
  scenario. Nothing consults the field.
- **Why it matters:** Same shape as F-M1 — a public author surface
  with no implementation. Tests authored against it pass; production
  use silently does nothing. The field originates from the legacy
  `ScenarioConfig` (`framework-types.ts:124-127`) and was carried
  forward into the new kind-specific configs.
- **Recommendation:** Drop `options` from `LoadScenarioConfig` /
  `ChaosScenarioConfig`. It's still on the legacy `ScenarioConfig`
  for `defineScenario` back-compat — that's fine; the new kinds
  shouldn't expose it until a real consumer arrives.

### F-M3 — `index.ts` re-exports the entire legacy `framework-types.ts` surface alongside the new kind APIs

- **Severity:** P3.
- **Where:** `index.ts:246-264`.
- **What:** The barrel re-exports 13 types from `framework-types.ts`,
  several of which (`CustomExecuteFn`, `ScenarioConfig`,
  `ScenarioType`, `ChaosConfig` from `base-types.ts`) are explicitly
  marked `@deprecated` or are legacy-only. The new kind-specific
  type re-exports (`LoadScenarioConfig`, `ChaosScenarioConfig`,
  etc.) sit above this block and are the canonical surface.
- **Why it matters:** Public-surface size signals "this is what we
  support." A new contributor reading `index.ts` sees `ScenarioConfig`
  and `ChaosConfig` exported on equal footing with
  `LoadScenarioConfig` / `ChaosScenarioConfig`, with no clear
  hierarchy. The `@deprecated` JSDoc tags help, but only at usage
  time.
- **Recommendation:** Annotate the legacy block with a top-level
  comment ("Re-exported only for `defineScenario` back-compat — to be
  removed when `defineScenario` is removed.") and re-export only what
  `defineScenario`'s public consumers actually need. `ScenarioType`,
  for instance, is unreferenced outside the legacy block in this
  package and likely not by external consumers either; verify and
  drop. Do this in the same release that retires `defineScenario`
  per F-N1.

## Overall assessment

Wave 1–4 cleaned up exactly the issues the 2026-05-22 audit flagged,
and the cleanup quality is high: the new files (`resolve-metric.ts`,
`validation.ts`, `run-load-window.ts`) carry good docstrings, the
`success_rate`-on-empty edge case got a documented decision rather
than being papered over, and the `RecipeRegistry<T>` promotion to core
landed with a real abstraction (warn/throw/overwrite policy) rather
than a copy-paste lift. The two pieces of "delegate to a shared
helper" Template Method work — `runLoadWindow` and the validators —
both correctly use composition of free functions rather than class
hierarchies, matching the prior audit's explicit recommendation.

What remains is shape-of-the-package work, not correctness:

- **F-N1 (legacy `execution-engine.ts` rip-out)** is the largest
  remaining lever. Now that the new kinds are unified on
  `runLoadWindow`, the ~410 lines of legacy executor surface in the
  same file are pure contributor-confusion tax. This is the next
  release's Wave 5 candidate.
- **F-M1 (chaos `execute` declared, not honored)** is a real
  correctness latent that snuck through the F8 refactor. Quick fix.
- **F-N2/F-N3/F-N4/F-M2/F-M3** are all P3 polish — none change
  behavior, all reduce surface confusion when contributors land.

The `simulation` package now sits at "experimental tool with sound
architecture" — the strategic patterns (kind discriminator,
discriminated result union, virtual `run()` dispatch, Template
Method via `runLoadWindow`, Strategy via predicate registry and
invariant-driver deps, free-function validation composition) are all
applied in the right places at the right granularity. Layering is
clean — only `@opensip-tools/core` and `@opensip-tools/contracts`
imports — and the public surface is well-organised barring the
legacy block in F-M3.

No P0 or P1 findings.
