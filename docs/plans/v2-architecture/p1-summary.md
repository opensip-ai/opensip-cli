# Phase 1 Summary — Extract `@opensip-tools/fitness` from core

## What landed

`@opensip-tools/fitness` is a new workspace package containing the fitness
engine (framework, recipes, signalers, targets, findings types, plugin
loader). `@opensip-tools/core` is now a strict kernel: language adapters,
plugin discovery, errors, logger, IDs, retry, signal types, project
config resolution. Every check pack and the CLI updated their imports;
no deprecation alias.

## Counts

- **Files moved with `git mv` (history preserved):** 64 source files
  including 11 test files. All of `packages/core/src/{framework,recipes,
  signalers,targets}/`, plus `types/findings.ts`, `types/severity.ts`,
  and `plugins/loader.ts` + its tests.
- **Modified files:** 211 (211 changed, 339 insertions, 406 deletions in
  `git diff --stat`). Most are import-statement rewrites in check packs.
- **Import sites rewritten:** 99 files touched by the mechanical rewriter
  (plus 63 from a second pass on checks-typescript). Manual touches: ~10
  for subpath imports (`@opensip-tools/core/framework/strip-literals.js`,
  etc.) and dynamic imports inside CLI's `fit.ts`.
- **New files:** 5 — `packages/fitness/{package.json, tsconfig.json,
  vitest.config.ts, src/index.ts, src/plugins/types.ts}`.
- **Deps added:** `@opensip-tools/fitness: workspace:*` to
  checks-{cpp,go,java,python,typescript,universal}, cli, lang-typescript.
  Core stays in those package.jsons (no removal — kernel is still pulled
  in directly for errors/logger/etc.).
- **Versions bumped to 2.0.0:** every package in the workspace, plus the
  root `package.json`.

## Judgment calls

1. **`types/signal.ts` stays in core** — `simulation/` consumes
   `Signal`, `SignalSeverity`, `SignalCategory`, `CreateSignalInput`,
   `FixHint`, `createSignal`. Per the plan's "prefer keeping things in
   core" guidance, this stays kernel. fitness imports them via
   `@opensip-tools/core`.

2. **`types/severity.ts` moved to fitness** — only consumers were
   `framework/result-builder.ts`, `framework/ignore-processing.ts`,
   `recipes/check-result-processor.ts`, all moving with fitness. It
   imports `SignalSeverity` from `@opensip-tools/core`.

3. **`plugins/loader.ts` moved to fitness** — the plan's listed split
   kept `plugins/loader.ts` in core, but the loader directly imports
   `defaultRegistry` (fitness), `defaultRecipeRegistry` (fitness), and
   `isCheck` (fitness). Keeping it in core would force a circular
   dependency. Moving it to fitness preserves behavior parity (the
   `lang` domain still works because the loader still hits
   `defaultLanguageRegistry`, which is imported from
   `@opensip-tools/core`). Phase 2 will hand this off to the Tool
   contract's `initialize()`. `loader.test.ts` and `lang-domain.test.ts`
   moved with it.

4. **`plugins/discover.ts` and `plugins/check-package-discovery.ts`
   stayed in core** — neither imports fitness symbols. Phase 2 renames
   `check-package-discovery.ts` to `tool-package-discovery.ts`.

5. **`FitPluginExports` interface moved to fitness** — references
   `Check` and `FitnessRecipe`. New file:
   `packages/fitness/src/plugins/types.ts`. Generic types
   (`PluginDomain`, `LoadedPlugin`, `DiscoveredPlugin`, `LangPluginExports`,
   `PluginExports`, `PluginMetadata`, `CheckDisplayEntry`,
   `PluginLoadResult`) stayed in `core/src/plugins/types.ts`.

6. **`stripStringLiterals`, `stripStringsAndComments`,
   `stripStringsAndCommentsPreservingPositions` added to fitness's
   barrel** — these were previously exported only via the deep subpath
   `@opensip-tools/core/framework/strip-literals.js`. Several check
   packs imported through the subpath; they now go through the fitness
   barrel.

7. **`lang-typescript` gained `@opensip-tools/fitness` dep** —
   `lang-typescript/src/strip.ts` re-exported `filterContent` /
   `clearFilterCache` / `FilteredContent` from the deep core subpath.
   Those moved to fitness, so lang-typescript now imports them from
   fitness. Slightly awkward (lang adapters are otherwise kernel-level),
   but it's a transient state — Phase 3's directory reorg can revisit
   the lang adapter / fitness boundary.

## Test counts

| Package            | Before | After |
|--------------------|--------|-------|
| core               | 134    | 91 (signal=16, lib=31, languages=18, plugins=35, types=0 inherited via signal) |
| fitness            | (new)  | 129 (framework=79, recipes=32, plugins=18) |
| cli                | 150    | 150 |
| simulation         | n/a    | n/a (passWithNoTests) |
| checks-typescript  | 6      | 6 |
| checks-universal   | 15     | 15 |
| lang-{*}           | unchanged | unchanged |

Total: previously ~305 test cases in core+cli+checks; now still all
green at ~370 visible test cases (the framework/recipes/plugins tests
are now reported under fitness).

## Verification

- `pnpm -r build` — green (16 packages, 0 errors)
- `pnpm -r typecheck` — green
- `pnpm -r test` — green (after fixing inline test fixtures in
  `loader.test.ts` to import `defineCheck` from fitness)
- DART `npx opensip-tools fit`:
  ```
  120 Passed, 0 Failed (0 Errors, 11 Warnings) | Duration 2.1s
  ```
  Bit-for-bit parity with main.

## Blockers / open questions

None.

The lang-typescript / fitness coupling on `filterContent` is the only
mild architectural smell from this phase. It's acceptable for Phase 1
because (a) it's a single subpath of usage, (b) `filterContent` is
genuinely fitness-shaped (it produces filtered text for security/
quality scanning), and (c) it can be revisited cleanly when Phase 3
moves directories around.
