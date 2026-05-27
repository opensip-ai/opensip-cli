# Consolidate registries + introduce RunScope

Replace the workspace's ten registry classes with one `Registry<T>` + closed `DuplicatePolicy` union (T2), then thread an explicit `RunScope` through `ToolCliContext` so per-invocation state stops living on module globals (T1). Sequenced T2 → T1 because the unified `Registry<T>` is a constituent of `RunScope`.

Source: `docs/plans/architecture/2026-05-27-architecture-cross-cutting-recommendations.md` — themes **T1** (process-wide mutable singletons replace explicit lifecycle) and **T2** (registry fragmentation: ten registries, five duplicate policies, no shared base).

## Problem

Two architectural patterns repeat across most packages and structurally block the user-global "all features must work in both embedded and SaaS modes" invariant from `CLAUDE.md`:

### T2 — Registry fragmentation (verified)

Ten registry classes implement a near-identical Map + duplicate-policy + structured-event template, with five different duplicate policies in production simultaneously:

| File | Class | Duplicate policy | LOC |
|---|---|---|---|
| `packages/core/src/tools/registry.ts` | `ToolRegistry` | first-writer-wins, warn | 78 |
| `packages/core/src/languages/registry.ts` | `LanguageRegistry` | first-writer-wins, warn + ext/alias indices | 141 |
| `packages/core/src/recipes/registry.ts` | `RecipeRegistry` | 3-mode via `allowOverwrite` + `throwOnDuplicate` flags | 197 |
| `packages/core/src/lib/id-name-tag-registry.ts` | `IdNameTagRegistry` | silent skip on id-dup; **throws** on name-collision | 81 |
| `packages/fitness/engine/src/framework/registry.ts` | `CheckRegistry` | silent skip | 124 |
| `packages/fitness/engine/src/recipes/registry.ts` | `FitnessRecipeRegistry` | throw on duplicate by default; constructor does I/O | 140 |
| `packages/fitness/engine/src/targets/target-registry.ts` | `TargetRegistry` | separate again | 130 |
| `packages/simulation/engine/src/framework/registry.ts` | wraps `IdNameTagRegistry` | inherited | 44 |
| `packages/simulation/engine/src/recipes/registry.ts` | `SimulationRecipeRegistry` | **bypasses parent's invariants** by writing to `protected` Maps (LSP violation) | 77 |
| `packages/graph/engine/src/lang-adapter/registry.ts` | adapter registry | first-writer-wins | 145 |
| `packages/graph/engine/src/rules/registry.ts` | rules array | — | 25 |
| `packages/dashboard/src/tool-tab-registry.ts` | tab registry | tab-id key | 77 |

Total: **~1259 LOC of registry code, five duplicate policies, two competing "common ancestor" attempts** (`id-name-tag-registry.ts:5-12` and `core/recipes/registry.ts:6-26` each call themselves the smaller common ancestor in their header comment).

The LSP violation is the keystone evidence: `SimulationRecipeRegistry` writes directly to its parent's `protected byId` / `byName` Maps at `packages/simulation/engine/src/recipes/registry.ts:32-39` because `RecipeRegistry`'s three-mode boolean duplicate policy doesn't have a clean "register built-ins without the duplicate guard" mode.

### T1 — Process-wide mutable singletons (verified)

Per-invocation state is hung on module globals across seven+ sites. Every singleton individually documents the same failure mode in a code comment ("if an in-process harness ever runs concurrently…", "called once before the first ensureScenariosLoaded()", "two copies of fitness can be loaded"). Sites:

- `packages/core/src/lib/logger.ts:231` — `export const logger: Logger = _logger;` mutated by free `setLogLevel`.
- `packages/core/src/languages/parse-cache.ts:108` — `let activeCache: LanguageParseCache | null = null;` plus free `initParseCache()` / `clearParseCache()`.
- `packages/core/src/languages/registry.ts` — `defaultLanguageRegistry` module-scope const.
- `packages/core/src/tools/registry.ts:78` — `defaultToolRegistry` same.
- `packages/fitness/engine/src/framework/file-cache.ts:210` — `export const fileCache = new FileCache()` with a 10-minute `setTimeout` auto-clear (the timer is the symptom).
- `packages/fitness/engine/src/recipes/check-config.ts:47` — `Symbol.for('@opensip-tools/fitness/currentRecipeCheckConfig')` stored on `globalThis`; `service.ts:122` / `:175` set and clear it in a try/finally.
- `packages/simulation/engine/src/framework/registry.ts:15` — `export const scenarioRegistry = …`. `defineLoadScenario` / `defineChaosScenario` / `defineInvariantScenario` / `defineFixEvaluationScenario` all register at module-import time as a side effect. The plugin loader uses snapshot-delta accounting (`plugins/loader.ts:108-133`) precisely to observe this side effect.
- `packages/cli/src/cli-context.ts:49-50` — `let currentProjectContext: ProjectContext | undefined; let datastoreCache: DataStore | undefined;` and `setProjectContextForRun` mutates both.
- `packages/languages/lang-typescript/src/filter.ts:145` — a separate module-level `filterCache` Map with its own 10-minute timer, distinct from `LanguageParseCache`, cleared independently.

Cost surfaces today as test plumbing asymmetry: simulation has `clearScenarioRegistry()` *and* `...WithoutRegistration` define twins; lang-typescript needs both `clearParseCache()` *and* `clearFilterCache()`; fitness has `reset()` on its recipe registry; CLI tests still leak. The "two registries that each claim to be the common ancestor" is the same shape at the registry layer.

## Target state

After this plan ships:

1. **One `Registry<T extends { id; name; tags? }>` in `@opensip-tools/core`** with a closed `DuplicatePolicy = 'warn-first-wins' | 'throw' | 'overwrite' | 'silent-skip' | 'allow-internal'` discriminated union. The base owns the Map, the by-id / by-name indices, the policy branch, and structured-event emission. Built-ins move into factories (`createDefaultRecipeRegistry()`), not constructors.

2. **One `RunScope` in `@opensip-tools/core`**, constructed once per CLI invocation (or per host in SaaS mode). Carries: `logger`, `parseCache`, `fileCache`, `recipeCheckConfig`, `projectContext`, `datastore` thunk, and the four primary registries (tools, languages, recipes per-tool). Threaded through `ToolCliContext` and consumed explicitly. The module-level holders in `cli-context.ts` go away.

3. **Scenarios and checks register explicitly, not via import side effect.** `defineLoadScenario` returns a `RunnableScenario`; the host's scenario-loader calls `scope.registerScenarios(...)`. The `...WithoutRegistration` twins disappear. The simulation plugin loader's snapshot-delta math (~25 lines) collapses to one call to a shared core loader.

4. **`SimulationRecipeRegistry` stops touching its parent's `protected` Maps.** Built-in registration uses the new `allow-internal` policy (or a `protected registerInternal()` seam).

5. **`IdNameTagRegistry` is deleted** — its consumers extend `Registry<T>` directly.

6. **Cross-package LOC drops by ~50%** in the registry layer (~1259 → ~600), and the test plumbing for singleton reset is removed across `core`, `fitness`, `simulation`, `lang-typescript`.

What this plan deliberately does NOT do:

- **T3** (`unknown` boundaries → generics). Independent of T1/T2. Sequenced after this plan.
- **T4** (relocate tool-shaped code: `Signal` → contracts, `SessionRepo` out of contracts, `maybeOpenDashboard` → `PostRunHookRegistry`). Independent; sequenced before T3.
- **T8** (delete dead affordances). Pure subtraction; can land anytime, ideally first.
- **Graph F1 / T5 quick win** (pass `adapter.ruleHints` to `rule.evaluate(...)` at `orchestrate.ts:189-201`). Already landed on branch `fix/graph-orchestrator-hints` — independent one-line correctness fix.

## Design principles

**No backwards compatibility for internal seams.** This is an architectural refactor. The five duplicate-policy boolean pairs collapse to one closed union; consumers update. We don't ship deprecation shims around new types.

**One factory + one policy per consumer.** A package's registry is *one* call to `new Registry<T>({ duplicatePolicy, indices, eventScope })`. Domain-specific lookups (by extension, by tag, by scope) live in *thin* subclasses or alongside, not woven into the base.

**`RunScope` carries explicit dependencies; nothing reaches into module globals.** A function that needs the parse cache, file cache, or logger takes them via parameter (often via `scope`). Default singletons survive only as a back-compat shim for one minor release, scoped to the legacy entry points.

**LSP must hold.** If a subclass needs to bypass a duplicate-policy check, the base class provides a named seam (`registerInternal()` / `allow-internal` policy). No more direct writes to `protected` Maps.

**Test plumbing shrinks.** Every `clearXForTesting()` / `...WithoutRegistration` twin / `_clearAdaptersForTesting` we delete is evidence the underlying lifecycle improved. The new test pattern is "construct a fresh `RunScope` per test"; the assertion at the end of the plan is that this constructor body is one line.

**Observability.** Every duplicate-rejection, registration, and registry-overflow event emits via the existing structured-logger convention: `evt: 'core.registry.<action>'`, `registry: 'tool' | 'language' | …`, with the conflicting id. The current registries already do this; the consolidation just makes the event shape uniform.

**Layer rules.** `Registry<T>` and `RunScope` live in `@opensip-tools/core`. No tool-shaped fields leak in (no `Signal`, no `Finding`, no recipe-config schema). `ToolCliContext` from `contracts` gains one new field (`scope: RunScope`) and tools consume it explicitly.

## Phases

| Phase | Name | Description | Effort | Depends on |
|---|---|---|---|---|
| 0 | Audit & design | Catalogue every registry call site; pin down `Registry<T>` API + `DuplicatePolicy` union + `RunScope` field set. Settle migration sequencing and the `allow-internal` seam. No code. | S | — |
| 1 | Build `Registry<T>` in core | New `packages/core/src/lib/registry.ts` + tests. Coexists with the legacy registries. Nothing migrated yet. | S | 0 |
| 2 | Migrate core registries | `ToolRegistry`, `LanguageRegistry`, `RecipeRegistry` extend the new base. Delete `IdNameTagRegistry`; update its consumers. | M | 1 |
| 3 | Migrate tool registries | `CheckRegistry`, `FitnessRecipeRegistry`, `TargetRegistry`, `SimulationRecipeRegistry` (kill LSP violation), simulation framework registry, graph adapter + rule registries, dashboard tab registry. | M | 2 |
| 4 | Build `RunScope` | New `packages/core/src/lib/run-scope.ts`. Constructor seams on `LanguageParseCache`, `FileCache`, `logger`. Default singletons preserved (deprecated). | S | 1 |
| 5 | Thread `RunScope` through `ToolCliContext` | `cli-context.ts` module globals removed. `ToolCliContext` gains `scope: RunScope`. Each tool's `register()` consumes `cli.scope` explicitly. | M | 3, 4 |
| 6 | Eliminate side-effect registration | `defineLoadScenario` / `defineChaosScenario` / `defineInvariantScenario` / `defineFixEvaluationScenario` return `RunnableScenario` without mutating `scenarioRegistry`. Loaders call `scope.registerScenarios(...)`. The `...WithoutRegistration` twins, the snapshot-delta math, `currentRecipeCheckConfig` via `globalThis`, `lang-typescript` filterCache singleton — all removed. | L | 5 |
| 7 | Verification | Full test sweep + dogfood gate. Add a SaaS-mode smoke test that constructs two `RunScope`s in one process and runs them concurrently against the existing fixtures. Pin the test plumbing reduction with a metric (LOC of `clear*ForTesting` / `*WithoutRegistration` deleted). | S | 6 |

## Dependency graph

```
0 — Audit & design
└── 1 — Registry<T> base
    ├── 2 — Migrate core registries (Tool, Language, Recipe; delete IdNameTagRegistry)
    │   └── 3 — Migrate tool registries (fitness ×3, simulation ×2, graph ×2, dashboard)
    │       └── 5 — Thread RunScope through ToolCliContext
    │           └── 6 — Eliminate side-effect registration
    │               └── 7 — Verification (SaaS-mode smoke + LOC reduction metric)
    └── 4 — RunScope base
        └── 5
```

Phases 1 and 4 are independent and can land in parallel PRs once Phase 0 has frozen both APIs. Phases 2 and 3 can split into per-package sub-PRs if review surface gets unwieldy.

## PR shape

Realistic shipping size: **3–5 PRs**, not one.

| PR | Phases | Reviewable in | Reverts cleanly? |
|---|---|---|---|
| PR A | 0 + 1 + 4 | < 1 day | Yes — new files only |
| PR B | 2 | ≤ 3 days | Yes — each registry migration is an isolated commit on the PR |
| PR C | 3 | ≤ 1 week | Yes — same |
| PR D | 5 + 6 (the keystone) | ≤ 1 week | Partial — side-effect-elimination changes are the riskiest commits |
| PR E | 7 | < 1 day | N/A — tests + docs |

The synthesis report's "one PR" framing is the *narrative* unit (T1 + T2 ship together); the engineering reality is that 5 PRs with the dependency chain above are easier to review and revert than one mega-PR. Each PR keeps `main` green throughout.

## Wiring points

The two structural wiring points that every phase touches:

1. **`packages/core/src/index.ts`** (the core barrel) — each new export (`Registry`, `DuplicatePolicy`, `RunScope`, `createDefaultRecipeRegistry`, …) is added once. Other packages consume via `import { Registry } from '@opensip-tools/core'`.

2. **`packages/contracts/src/cli-context.ts`** (`ToolCliContext`) — gains `readonly scope: RunScope`. Every tool's `register(cli)` body switches from `getDefaultParseCache()` / module-level `scenarioRegistry` to `cli.scope.parseCache` / `cli.scope.scenarioRegistry`.

## Conventions (from `CLAUDE.md`)

- **Test framework:** Vitest. `*.test.ts` alongside source.
- **Imports:** workspace barrels (`@opensip-tools/core`, `@opensip-tools/contracts`). Internal imports use relative paths with `.js` extension (ESM Node16). Type-only imports use `import type`.
- **Error pattern:** `ToolError` with `code` field. Registries that reject duplicates throw `ValidationError`; structured event emits first.
- **Logger event shape:** `evt: 'core.registry.<action>'`, `module: 'core:registry'`, plus `registry: '<name>'`, `id`, `name?` fields.
- **Layer rules** (enforced by dependency-cruiser): `core` must NOT import from `contracts`, `cli`, `fitness`, `simulation`, `lang-*`, or `checks-*`. `RunScope` lives in core; `ToolCliContext` in contracts. Threading happens at the contracts ↔ tool boundary.

## Risks

- **Compile-fan-out during PR C.** Migrating ten registries simultaneously could cascade type errors into every check pack and every tool. Mitigation: Phase 3 splits per-namespace (fitness → simulation → graph → dashboard) and each commit on PR C keeps `pnpm typecheck` green.
- **Side-effect elimination changes user-facing `defineX` semantics.** Today, `import './my-scenario.ts'` is enough to register a scenario. Phase 6 removes that. Mitigation: the plugin loader explicitly calls `scope.registerScenarios(module.scenarios)`, and the scenario authoring docs / examples are updated in the same PR. Existing third-party `defineX` users get a clear error from a runtime guard ("This scenario was defined but not registered — pass it through `host.registerScenarios()`.").
- **`globalThis` Symbol slot has third-party consumers.** `Symbol.for('@opensip-tools/fitness/currentRecipeCheckConfig')` is a public name even though it's documented as internal. Phase 6 must search for external consumers (GitHub code search across `opensipTools.kind: check-pack` packages) before removing the slot. Mitigation: emit a one-release deprecation log when the slot is read; remove the slot in the next major.
- **The "two competing common ancestor" registries each have callers that exploit their differences.** Some consumers want the silent-skip of `IdNameTagRegistry` (re-importing the same check is fine); others want the throw of `RecipeRegistry` (collisions are bugs). The closed `DuplicatePolicy` union must cover both honestly. Phase 0 must enumerate every existing duplicate-policy site and assign each one a named policy before Phase 1 begins.
- **`SimulationRecipeRegistry` LSP fix may surface latent collisions.** The current bypass exists because something would otherwise throw. Phase 3 needs a test that exercises the path the bypass currently silences — likely "register the built-in `default` recipe alongside a user-supplied `default`" — and confirms the new `allow-internal` policy produces the desired outcome (built-in wins silently, user-supplied user-supplied throws on a *third* registration).

## Acceptance criteria

The plan is complete when:

- [ ] One `Registry<T>` class exists in `@opensip-tools/core`; the eleven previous registry classes (excluding the dashboard tab registry, which is a different shape and may stay separate) are either deleted or are thin subclasses adding domain-specific indices.
- [ ] `IdNameTagRegistry` is deleted from the codebase.
- [ ] `SimulationRecipeRegistry` does not reference any `protected` member of its parent. The LSP violation is gone.
- [ ] `RunScope` exists in `@opensip-tools/core` and is constructed exactly once per CLI invocation in `packages/cli/src/index.ts`.
- [ ] `ToolCliContext` exposes `scope: RunScope`. Every `cli.foo` access for state previously held in module globals goes through `cli.scope.foo`.
- [ ] `cli-context.ts` has no module-level mutable state (no `let currentProjectContext`, no `let datastoreCache`).
- [ ] `defineLoadScenario`, `defineChaosScenario`, `defineInvariantScenario`, `defineFixEvaluationScenario` return `RunnableScenario` without registering anywhere. `...WithoutRegistration` twins are deleted.
- [ ] `Symbol.for('@opensip-tools/fitness/currentRecipeCheckConfig')` is no longer read or written. `recipeCheckConfig` lives on `RunScope`.
- [ ] `lang-typescript`'s separate `filterCache` is merged into `RunScope.parseCache` (or its own scope field if the lifetime differs).
- [ ] `packages/simulation/engine/src/plugins/loader.ts:108-133`'s snapshot-delta math is replaced with a `host.loadAllPlugins(...)` call to a shared core loader.
- [ ] A new SaaS-mode smoke test constructs two `RunScope`s in one process and runs them concurrently against existing fixtures without state leakage.
- [ ] Registry / lifecycle test plumbing LOC drops by ≥ 50% (`clearXForTesting`, `_clearAdaptersForTesting`, `clearScenarioRegistry`, `clearFilterCache`, `clearParseCache`, `reset()` on FitnessRecipeRegistry).
- [ ] `pnpm typecheck && pnpm test && pnpm lint` is green. Dependency-cruiser layer rules unchanged. `pnpm fit` (the dogfood gate) does not regress.

## Out-of-band quick wins (already shippable)

These are not in the plan's critical path but ride well with it:

- **Graph F1 / T5** (`fix/graph-orchestrator-hints` branch) — `rule.evaluate(catalog, indexes, config, adapter.ruleHints)` at `orchestrate.ts:189-201`. One-line correctness fix + drift test. Already pushed; merge separately.
- **T8 deletions** (dead affordances). Pure subtraction. Per-package audit findings list them. Suggested ordering: ship as one cleanup PR before PR A; reduces noise in the Phase-0 catalogue.

## References

- `docs/plans/architecture/2026-05-27-architecture-cross-cutting-recommendations.md` — synthesis with T1 + T2 sections (and the eight other themes).
- Per-package audits: `docs/plans/architecture/2026-05-27-architecture-{core,fitness,simulation,graph,cli,languages}.md` — registry- and singleton-related findings cited verbatim above.
- `CLAUDE.md` — layer rules; "all features must work in both embedded and SaaS modes."
