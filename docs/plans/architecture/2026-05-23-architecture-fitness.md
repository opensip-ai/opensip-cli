---
status: current
last_verified: 2026-05-23
title: "Architecture audit (delta) — @opensip-tools/fitness"
package: "@opensip-tools/fitness"
audience: [contributors, architects]
prior-audit: ./2026-05-22-architecture-fitness.md
remediation-plan: ./2026-05-22-plan-layer-3-tools-and-lang.md
---
# Architecture audit (delta) — @opensip-tools/fitness

## Summary

Wave 1–4 closed 11 of the 15 prior findings. Closure commits:
`executeFit` decomposition (`856508e`), `runOneCheck` lifecycle
unification (`4794c3c`), severity table + gate identity strategy +
typed SARIF builder (`a5e7f01`), `defineRegexListCheck` (`14f8c83`),
`filterContent` move to `lang-typescript` (`3bc3f1b`),
`getASTLineNumber` rename + shared `COMMENT_OPENERS` + dashboard
editor through `signalersConfig` (`8f8c63f`), `RecipeRegistry<T>`
promoted to core (`426fcc6`), live-view registration on
`ToolCliContext` (`7bc3160`). The `lang-no-fitness-except-typescript`
back-edge exception is gone (`.dependency-cruiser.cjs:235-243`).

The four open prior findings (#1, #4, #10, #12, plus #14 broader
cache consolidation) are all in the deferred set both the original
audit and the Layer-3 plan named. Net-new findings (F1–F5) are
small. Five additional pre-existing findings (F6–F10) were missed by
the prior audit and are surfaced here.

## Prior-finding status (as of `8f8c63f`)

| # | Title                                           | Status      | Closed by               |
|---|-------------------------------------------------|-------------|-------------------------|
| 1 | Analysis-mode dispatch is Strategy in disguise  | OPEN        | (deferred per plan)     |
| 2 | Severity-mapping primitive obsession            | CLOSED      | `a5e7f01`               |
| 3 | `executeFit` 612-line function                  | CLOSED      | `856508e`               |
| 4 | Recipe `globalThis` projection                  | OPEN        | (deferred per plan)     |
| 5 | Parallel/sequential lifecycle duplication       | CLOSED      | `4794c3c`               |
| 6 | Gate hashing strategy hard-coded                | CLOSED      | `a5e7f01`               |
| 7 | SARIF "builder" is inline walker                | CLOSED      | `a5e7f01`               |
| 8 | `fitnessTool.register` long subcommand wiring   | CLOSED      | `856508e`               |
| 9 | `CheckSelector` doc-only finding                | CLOSED      | `check-resolution.ts:16-29` |
| 10| Tool `initialize` no-op masking module state   | OPEN        | (deferred per plan)     |
| 11| Two parsers re-implement comment-openers        | CLOSED      | `8f8c63f`               |
| 12| Service `start` throws vs `Result<T,E>`         | OPEN        | (deferred per plan)     |
| 13| Hand-rolled YAML extractor in dashboard         | CLOSED      | `8f8c63f`               |
| 14| `LRUCache` duplicates core infrastructure       | OPEN        | (deferred per plan)     |
| 15| Two `getLineNumber` exports                     | CLOSED      | `8f8c63f`               |

Spot-check verifications:

- **#2.** `severity-mapping.ts:39-47` is the frozen
  `TAG_TO_CATEGORY` table; the warn-once diagnostic at `:56-75`
  surfaces unknown tags at startup.
- **#3.** `cli/fit.ts:329-621` defines `loadFitConfig`,
  `validateLanguagesAgainstAdapters`, `selectRecipe`,
  `buildCliOutput`, `buildFitDoneResult`, `buildFitCallbacks`,
  `runRecipeOrAdHoc`. `executeFit` shrinks to 66 lines (`:627-692`);
  the `sonarjs/cognitive-complexity` suppression is gone.
- **#5.** `recipes/run-one-check.ts` is the single per-check
  lifecycle; `parallel-execution.ts:50-113` keeps only the
  sliding-window scheduling, `sequential-execution.ts:20-50` only
  the `for-of`. Abort semantics reconciled per the file header.
- **#6.** `gate.ts:68-76` exports `ViolationIdentity` and
  `DEFAULT_VIOLATION_IDENTITY`; `compareToBaseline:153-156` accepts
  the strategy and threads it through both extraction helpers.
- **#7.** `sarif/types.ts` is the shared `SarifResult` shape;
  `sarif.ts:34-81` is the typed `SarifResultBuilder`. Both `gate.ts`
  and `sarif.ts` import from the shared types module.
- **#8.** `tool.ts:103-127` is a 24-line orchestrator; each
  subcommand has its own `registerXxxCommand`; the `fit` action
  dispatches through `runListMode` / `runRecipesMode` /
  `runJsonMode` / `runLiveMode` / `runGateMode`.
- **#9.** `recipes/check-resolution.ts:16-29` carries the
  intentional-typed-switch documentation block.
- **#11.** `framework/comment-openers.ts` is the shared table;
  `directive-parsing.ts:64-71` and `directive-inventory.ts:60`
  both consume it. The inventory now correctly accepts
  `<!--` and `#` openers.
- **#13.** `signalers/schema.ts:107-109` declares the
  `DashboardSchema`; `cli/dashboard.ts:53-62` reads
  `config.dashboard?.editor ?? null`.
- **#15.** `framework/ast-utilities.ts:31` exports
  `getASTLineNumber` directly; `result-builder.ts:209` keeps the
  unrelated content+index `getLineNumber`. One name, one signature.

No prior finding regressed.

## Net-new findings (introduced by Wave 1–4)

### F1 — `defineRegexListCheck` accepts `provider` only at the check level

- **Severity:** P3.
- **Where:** `framework/define-regex-list-check.ts:147`
  (`provider` on `DefineRegexListCheckConfig`),
  `RegexListCheckPattern` (`:61-78`) — no per-pattern field.
- **What:** API surface honesty. The helper has a `provider` at the
  check level only; per-pattern provider overrides aren't supported,
  but neither the type nor the JSDoc says "check-level only."
- **Why it matters:** A contributor wanting per-pattern Aristotle
  attribution (security → `sax-04`, perf → `sax-07`) will reach for
  `RegexListCheckPattern.provider` and not find it; the workaround
  (split into two checks) duplicates the helper's per-pattern
  iteration.
- **Recommendation:** Document the check-level-only contract on
  both JSDocs now; add a per-pattern field if/when a real driver
  appears.

### F2 — `executeFit` orchestration ordering inverts a precondition

- **Severity:** P2.
- **Where:** `cli/fit.ts:633` (`ensureChecksLoaded(args.cwd)`),
  `:636` (`selectRecipe(args)` — calls `defaultRecipeRegistry.has`),
  `:640` (`loadFitConfig(args)`).
- **What:** SRP / sequencing. `selectRecipe` runs *before*
  `loadFitConfig`, but `selectRecipe` checks
  `defaultRecipeRegistry.has(recipeName)` — and recipes are
  registered as a side-effect of `ensureChecksLoaded` (which loads
  fit-domain `.mjs` plugins, including any user recipe files under
  `<cwd>/opensip-tools/fit/recipes/`). The ordering happens to work
  because `ensureChecksLoaded` is awaited at line 633 before
  `selectRecipe` runs at line 636 — so the recipe registry is
  populated before the lookup. However, `loadFitConfig` is sequenced
  *after* `selectRecipe`, which means a config error (missing
  `opensip-tools.config.yml`) is reported only when the recipe name
  validates. A user with both an unknown recipe AND a missing config
  sees "Unknown recipe 'foo'" first; a user with a known recipe and
  a missing config sees the config error.
- **Why it matters:** Two inconsistencies in user-facing messages:
  (a) the order of error precedence is "load checks → recipe name →
  config", but ergonomically "config → recipe name" is more useful
  (the config tells you what recipes exist). (b) The implicit
  dependency from `selectRecipe` to `ensureChecksLoaded` is invisible
  in the function signature; a contributor inverting the two lines
  would silently break recipe lookup for user-provided recipes
  loaded via plugins.
- **Recommendation:** Move `loadFitConfig` to immediately after
  `ensureChecksLoaded` (lines 633→640→636). Add a JSDoc on
  `selectRecipe` that names the precondition: "must run *after*
  `ensureChecksLoaded` so user-defined recipes are visible in the
  registry."

### F3 — `runJsonMode` writes to `process.stdout` directly; live/list/recipes modes go through `cli.render`

- **Severity:** P3.
- **Where:** `tool.ts:253-264` (`runJsonMode`),
  `:235-239` (`runListMode`), `:242-246` (`runRecipesMode`),
  `:188-195` (`registerDashboardCommand`'s json branch),
  `:206-210` (`registerListCommand`'s json branch),
  `:221-225` (`registerRecipesCommand`'s json branch).
- **What:** SRP / Strategy consistency. Six places write JSON to
  stdout via `process.stdout.write(JSON.stringify(...) + '\n')` —
  identical shape. The `ToolCliContext` doesn't expose a JSON
  emitter (`cli.render` is for Ink), so each call site rolls its
  own. The string `'\n'` suffix is duplicated six times; the
  `JSON.stringify(..., null, 2)` indent argument is duplicated six
  times.
- **Why it matters:** Open/Closed — adding a JSON post-processor
  (e.g. emit to a file via `--out`, or pipe through an envelope
  with timestamp + tool id) requires editing six call sites.
  Cosmetic today; a small Strategy seam pays back the first time
  someone needs structured output beyond raw JSON-to-stdout.
- **Recommendation:** Add `cli.emitJson(value: unknown): void` to
  the `ToolCliContext` contract (lives in core), have it dispatch
  through whatever IO seam the CLI owns (today
  `process.stdout.write`). Migrate the six call sites in
  `tool.ts`. Delete the duplication. Same pattern available to
  every other tool.

### F4 — `tool.ts` `register` keeps a no-op `initialize` while the `metadata.id` literal is duplicated

- **Severity:** P3 (related to prior #10 — open).
- **Where:** `tool.ts:45` (`FIT_LIVE_VIEW_KEY = 'fit'`),
  `:354` (`metadata: { id: 'fitness', ... }`),
  `:112-114` (`cli.builtinLiveViews.get(fitnessTool.metadata.id)`),
  `:360-366` (the no-op `initialize`).
- **What:** Two literals describe the same registration. The
  `metadata.id` is `'fitness'` (used as the key into
  `cli.builtinLiveViews`); the `FIT_LIVE_VIEW_KEY` is `'fit'`
  (used as the key passed to `cli.registerLiveView` and consumed
  by `cli.renderLive`). The mismatch is intentional — fitness
  registers under `'fit'` for the `fit` subcommand's live view,
  and under `'fitness'` for the tool registry — but the comment
  at `:42-45` is the only place that explains the distinction.
- **Why it matters:** A contributor reading the `cli.builtinLiveViews`
  lookup will reasonably wonder why `metadata.id` (`'fitness'`)
  pulls a renderer that fitness then *re-keys* to `'fit'`. The
  shape works but the indirection is one comment-change away from
  drift. The no-op `initialize` adds to the confusion: it's the
  natural place to do the live-view binding (or to fail fast when
  no renderer ships), but today the binding lives inline in
  `register`.
- **Recommendation:** Move the live-view binding out of `register`
  into `initialize`, where lifecycle work belongs. Add a top-of-file
  comment naming the two-key invariant: "tool id is `'fitness'`
  (the package-wide identifier); the live-view key is `'fit'`
  because it matches the subcommand name; the CLI ships one
  renderer per tool id, fitness re-keys it to its subcommand
  name." Even if `initialize` stays a no-op pending the broader
  Finding #10 cleanup, naming the indirection is free.

### F5 — `service.ts:151` casts the recipe-mode dispatch through a ternary on `'parallel'`

- **Severity:** P3.
- **Where:** `recipes/service.ts:151`
  (`await (recipe.execution.mode === 'parallel' ? executeParallel(execCtx, execOpts) : executeSequential(execCtx, execOpts));`).
- **What:** Strategy in disguise (a smaller version of the original
  prior #1). The recipe service has two execution modes
  (`'parallel'`, `'sequential'`) and dispatches inline. Both
  executors share `(ctx: ExecutionServiceContext, opts:
  ExecutionOptions) => Promise<void>` exactly — they're already
  shaped as a Strategy by `runOneCheck`'s extraction; the
  dispatcher just hasn't taken the shape.
- **Why it matters:** Adding a third mode (e.g. `'staged'` for the
  long-rumoured incremental-fit, or `'isolated'` for sandbox-per-check
  testing) means editing this ternary AND
  `recipes/types.ts`'s `ExecutionMode` union. The
  Strategy table (`Map<ExecutionMode, Executor>`) gives the
  compiler the same exhaustiveness guarantee Phase D2 chose for
  per-check lifecycle. Today's two-mode ternary is fine; the
  shape is asking for tabularization the moment a third mode
  appears.
- **Recommendation:** Once `'staged'` (or any third mode) is
  proposed, refactor to a `Map<ExecutionMode, (ctx, opts) =>
  Promise<void>>` with an exhaustive lookup. Until then, the
  ternary is small enough that introducing the table now would be
  premature. Document the trade-off at the top of `service.ts`
  the same way `check-resolution.ts:16-29` documents its
  typed-switch choice.

## Findings the original audit missed

These existed in the previous source but were not surfaced by the
2026-05-22 audit. They are not regressions; they are pre-existing
shapes that became more visible as the refactors above closed the
big-ticket findings.

### F6 — `cli/fit.ts` carries module-singleton state that survives `executeFit`'s decomposition

- **Severity:** P2.
- **Where:** `cli/fit.ts:45-46` (`checksLoaded`, `pluginLoadErrors`),
  `:54` (`mergedCheckDisplay`), `:55-56` (`getCheckDisplayName`,
  `getCheckIcon` mutable bindings), `:99` (`preLoadHook`).
- **What:** SRP / DIP. The `executeFit` decomposition (Wave 1)
  pulled five phase helpers out into named functions, but the
  surrounding module retains five module-scope `let`/`const`
  singletons that those helpers read and write. The phase
  helpers are now unit-testable in isolation; the module is not.
  This is the same shape as prior Finding #10 (the `initialize`
  no-op masking real wiring), now visible at the function level.
- **Why it matters:** The phase decomposition implies a lifecycle
  ("load → select → validate → run → output") that the module
  state breaks: `pluginLoadErrors` is set during
  `ensureChecksLoaded` and read by `buildCliOutput` (line 450:
  `pluginLoadErrors.length === 0`) and `buildFitDoneResult`
  (line 519). Two phase helpers consume hidden module state the
  caller cannot see. A test that wants to drive `buildCliOutput`
  with a specific plugin-error count must reach into the
  module's private state.
- **Recommendation:** The Phase D1 plan stops short of this; the
  cleanup is Phase D5+ work. The right shape is a `FitnessRuntime`
  (the same object Finding #10 proposed) carrying the four pieces
  of state, threaded into each phase helper as an argument. Until
  that lands, the lowest-effort fix is an internal `getRuntime():
  { pluginLoadErrors; getCheckDisplayName; getIcon }` with a
  test-only `__resetForTesting__` escape hatch. Document the
  invariant ("module state is per-process; do not embed two
  fitness clones in one process") on the file's leading comment.

### F7 — `runOneCheck` couples the timeout-detection signal to the AbortController identity

- **Severity:** P3.
- **Where:** `recipes/run-one-check.ts:101-103` (controller +
  setTimeout), `:128` (the `if (checkAbortController.signal.aborted)`
  timeout detection).
- **What:** The reconciled timeout detection is "any aborted signal
  on the per-check controller means the timeout fired" — the
  comment at `:125-127` makes the assumption explicit. This is
  correct *today* because the only abort pathway into this
  controller is the local `setTimeout` callback. The comment also
  acknowledges the prior parallel/sequential divergence that
  motivated the consolidation. Where it gets brittle: any future
  consumer of this `signal` (a per-check cooperative cancel from
  the scheduler, an abort propagated from
  `service.abortController` if the wiring changes) would silently
  start being reported as a timeout.
- **Why it matters:** The invariant ("only the timeout aborts this
  signal") is load-bearing and unenforced. Phase D2 documented the
  abort-source choice in code comments, but the abort *origin*
  isn't in any test. A regression would surface as wrong-error-
  reason output (timeouts mis-reported as errors with `timedOut:
  true`); the calling code would still log + record correctly,
  but the user would see "Check X timed out at Yms" when in fact
  another component cancelled it.
- **Recommendation:** Either (a) attach a tagged reason to the
  abort (`controller.abort(new TimeoutAbortReason(timeoutMs))` and
  detect via `signal.reason instanceof TimeoutAbortReason`), or
  (b) keep the current shape but add a regression test that
  asserts an externally-aborted signal does NOT produce a
  timeout-flagged error. (a) is the more durable fix; (b) is the
  cheap pin.

### F8 — `defineRegexListCheck` hardcodes `analyze` mode

- **Severity:** P3.
- **Where:** `framework/define-regex-list-check.ts:283-294`.
- **What:** Template Method completeness. The helper synthesises
  only `defineCheck`'s `analyze` mode. Cross-file regex-list
  semantics (e.g. correlated patterns across `package.json` +
  `Dockerfile`) would require either a new helper or a fork of
  this one.
- **Recommendation:** Add a JSDoc note that names the per-file
  intent and points future contributors at extracting
  `processOneFile(content, filePath, options)` for a future
  analyzeAll-mode wrapper. Documentation only.

### F9 — Strip-literal / filterContent rationale duplicated across three files

- **Severity:** P3.
- **Where:** `framework/strip-literals.ts:1-12`, `index.ts:39-46`,
  `languages/lang-typescript/src/strip.ts:1-9`.
- **What:** DRY in documentation. Why fitness keeps the
  regex-based language-agnostic strippers and lang-typescript owns
  the TS-AST-aware cached `filterContent` is described in three
  places. Future contributors read one and not the other two.
- **Recommendation:** Consolidate the rationale on
  `strip-literals.ts:1-12` and reference it from the other two
  locations. Name the dispatch boundary
  (`core/languages/content-filter-dispatch.ts:applyContentFilter`)
  explicitly so any new stripper plugs in at the right seam.

### F10 — `recipes/check-config.ts:64` types the return as `T` but accepts any `T extends Record<string, unknown>`

- **Severity:** P3.
- **Where:** `recipes/check-config.ts:64`
  (`getCheckConfig<T extends Record<string, unknown>>(slug: string): T`).
- **What:** Strategy / type honesty. The function returns `{} as T`
  on miss (line 66) and `entry as T` on hit (line 69) — both
  unsafe casts. There is no runtime validation that the stored
  entry actually conforms to `T`. The `T extends Record<string,
  unknown>` constraint admits any object shape; a check that
  declares `getCheckConfig<{ allowList: string[] }>('foo')` and
  receives `{ allowList: 'string-not-array' }` will read a string
  where it expects an array and crash at use site.
- **Why it matters:** The recipe-config-via-globalThis trade-off
  documented in prior Finding #4 explains *why* the slot lives
  there; it doesn't explain why the slot is unvalidated. A check
  that augments its built-in defaults with the slot value gets
  no runtime guard against a malformed recipe config — the
  failure surfaces as a misleading runtime error inside the
  check's analyze callback.
- **Recommendation:** Either (a) require checks to pass a Zod
  schema (`getCheckConfig(slug, schema): T`) and validate at
  read time, or (b) return `unknown` and let each check call
  site narrow with its own type guard. (a) is the durable fix
  matching the rest of the package's validation discipline
  (signalers, targets); (b) is the lighter local change. Do
  not leave the unvalidated cast — it works *because* nothing
  embeds bad config today, not because the type protects.

## Layering verification

- Fitness imports flow `core` ← `contracts` (top-down). No imports
  from `cli`, `simulation`, `graph`, `lang-*`, or `checks-*`.
  Verified `cli/fit.ts`, `tool.ts`, `recipes/*`, `framework/*`,
  `gate.ts`, `sarif.ts`.
- `lang-typescript` is a `devDependencies` entry only
  (`package.json:46`) — used inside
  `framework/__tests__/content-filter-dispatch.test.ts` for the
  language-adapter contract tests, and nowhere in `src/`.
- The `lang-no-fitness-except-typescript` exception is gone; the
  replacement rule is `lang-no-fitness` (no exception, hard error)
  at `.dependency-cruiser.cjs:235-243`.
- `framework/strip-literals.ts` (regex-based, language-agnostic)
  coexists with `lang-typescript/filter.ts` (TS-AST-aware, cached)
  by design — see F9 above on the documentation, not the code.

## Public surface (`src/index.ts`)

The barrel re-exports stay clean:

- Wave 1–4 added `defineRegexListCheck`, `RegexListCheckPattern`,
  `RegexListCheckOptions`, `DefineRegexListCheckConfig` (lines
  3–8), `getASTLineNumber` (line 31), and reorganised the comment
  at lines 25–46 to explain the lang-typescript split.
- The `ts` namespace re-export from prior fitness is gone — checks
  consuming `ts` import from `@opensip-tools/lang-typescript`
  directly. The barrel comment at lines 41–46 documents this.
- `getLineNumber` (content + index) and `getASTLineNumber` (node +
  source) coexist as distinct named exports per Phase D5; both are
  reachable from the barrel.
- `FitnessRecipeRegistry` extends core's `RecipeRegistry<T>`
  (`recipes/registry.ts:46`) and is exported alongside the kernel
  type — the wrapper retains its built-in / override-tracking
  responsibilities.
- No obsolete exports detected; the Wave-1–4 re-exports are
  consumed by check packs and the CLI.

## Overall assessment

Fitness is in materially better shape after Wave 1–4. The four
remaining open prior findings (#1, #4, #10, #12, plus #14 broader
cache consolidation) are all in the deferred set the original audit
and Layer-3 plan named explicitly — they are blocked on contract
decisions (multi-instance fitness in one process; service-class
result-pattern semantics; cache-eviction-policy unification) that
should not land opportunistically.

The five net-new findings (F1–F5) are minor: two are
documentation-shape (F1, F4), one is a sequencing nit (F2), one is
duplication of a tiny IO seam across six sites (F3), and one is a
small Strategy-tabularization opportunity that is not yet worth
doing (F5). None block other refactors.

The five missed-by-prior-audit findings (F6–F10) are pre-existing.
F6 (module-singleton state in `cli/fit.ts`) is the largest of these
and is the natural follow-on to prior #3 + #10 — it should be
sequenced ahead of any further `executeFit` decomposition work. F7
(timeout-detection signal coupling) is a single-line invariant
worth pinning with a test now. F8, F9, F10 are documentation /
type-honesty fixes that fit any future cleanup pass.

No P0/P1 issues; F2 and F6 are the two P2s and both are localised.
The package is safe to ship; the cleanups improve contributor
ergonomics rather than correcting bugs.
