# knip cleanup summary

Drove `knip` findings to zero across the opensip-tools workspace, with a
small, justified set of config exclusions for runtime-discovered packages
and dynamic-require deps.

## Final knip output

```
$ ./node_modules/.bin/knip
$ echo $?
0
```

Knip reports **zero** findings of every category (unused files, unused
dependencies, unused devDependencies, unlisted dependencies, unlisted
binaries, unused exports, unused exported types, duplicate exports,
configuration hints).

## Per-category actions

### Unused files (12 → 0)

Deleted as truly dead code, verified by ripgrep before removal:

- `packages/fitness/engine/src/framework/pattern-detector.ts`
- `packages/fitness/engine/src/framework/process-cleanup.ts`
- `packages/fitness/engine/src/framework/target-types.ts`
- `packages/fitness/checks-typescript/src/utils/ts-ast.ts` (unused
  `hasExportModifier` helper, plus barrel re-export removed)
- `packages/fitness/engine/src/targets/define-target-config.ts`
  (`defineTargetConfig` had no callers)
- `packages/simulation/engine/src/framework/index.ts` (orphan barrel —
  the package barrel `simulation/engine/src/index.ts` re-exports
  directly from the underlying modules)
- `packages/simulation/engine/src/framework/validation/scenario-validator.ts`
  (only the dead barrel above imported it; `validation/` directory
  removed as empty)
- `packages/simulation/engine/src/recipes/define-recipe.ts`
- `packages/simulation/engine/src/recipes/recipe-registry.ts`
- `packages/simulation/engine/src/recipes/recipe-service.ts`
- `packages/simulation/engine/src/recipes/recipe-types.ts`
- `packages/simulation/engine/src/recipes/README.md` (and `recipes/`
  directory removed) — abandoned simulation-side recipe layer that
  pre-dated the kind-specific `defineLoadScenario` /
  `defineChaosScenario` etc. introduced by Plan 01 Phase 0b.5

Test fixtures under `packages/cli/src/__tests__/fixtures/**` were NOT
deleted — they are real test data. Added them as an `entry` glob in the
cli workspace config so knip resolves them as legitimate entry points.

### Unused dependencies (22 → 0)

**Removed from package.json (verified zero static or dynamic imports):**

- root `@vitest/coverage-v8` was momentarily removed but re-added — the
  coverage config in `packages/cli/vitest.config.ts` and
  `packages/core/vitest.config.ts` makes vitest pick it up indirectly.
  Knip recognizes this once the dep is hoisted at root, so it stays.
- `packages/cli/package.json`: `glob`
- `packages/core/package.json`: `glob`, `minimatch`, `zod`,
  `@types/js-yaml` (the only `js-yaml` use is a `requireFromHere` cast
  to a structural type — no `@types` needed)
- `packages/fitness/checks-cpp/package.json`: `@opensip-tools/core`,
  `@opensip-tools/lang-cpp`
- `packages/fitness/checks-go/package.json`: `@opensip-tools/core`,
  `@opensip-tools/lang-go`
- `packages/fitness/checks-java/package.json`: `@opensip-tools/core`
  (kept `@opensip-tools/lang-java` — used in tests)
- `packages/fitness/checks-python/package.json`: `@opensip-tools/core`,
  `@opensip-tools/lang-python`
- `packages/fitness/checks-typescript/package.json`: `glob`
- `packages/simulation/engine/package.json`: `zod`

These were stale leftovers from the P1 fitness split — the
`@opensip-tools/checks-*` packages now import only from
`@opensip-tools/fitness`, not from core or the language packs.

**Kept in package.json with knip-config exclusions** (real runtime deps
that knip's static analysis can't see):

- cli's `@opensip-tools/checks-typescript`, `@opensip-tools/checks-universal`,
  `@opensip-tools/lang-{cpp,go,java,python,rust,typescript}` — discovered
  at runtime via `discoverToolPackages()` /
  `discoverCheckPackages()` (any npm package whose `package.json`
  declares `opensipTools.kind`). Listed under the cli workspace's
  `ignoreDependencies` in `knip.json`.
- core's `js-yaml` — loaded via `createRequire()` /
  `requireFromHere('js-yaml')` to avoid a circular dep between
  `plugins/` and `targets/`. Listed under the core workspace's
  `ignoreDependencies` in `knip.json`.

### Unlisted binary (1 → 0)

`dot` (graphviz) is invoked by the root `depcruise:graph` script. It's a
system binary, not a node dep. Added to `ignoreBinaries` in `knip.json`.

### Unused exports (96 → 0)

Triaged each finding individually:

- **Made non-exported** when the symbol was used only inside its own
  file (a clean encapsulation win). Examples: `INIT_FILENAME`,
  `generateInitConfig`, `inferDomain`, `BANNER`, `BANNER_SAUCER`,
  `ClockContext`, `SPINNER_FRAMES`, `TEST_FILE_PATTERNS` (×2 packages),
  `CheckIdSchema`, `CommandConfigSchema`, `CheckScopeSchema`,
  `UnifiedCheckConfigSchema`, `BaseCheckConfig`, `WEAK_REASON_PATTERNS`,
  `FileAccessorImpl`, `FileCache`, `MemoryProfiler`,
  `DEFAULT_API_FILE_PATTERNS`, `resolveFilesForCheck`, all 10
  `*Recipe` constants in `built-in-recipes.ts` (still used internally
  via `builtInRecipes` array), `DEFAULT_EXECUTION_OPTIONS`,
  `DEFAULT_REPORTING_OPTIONS`, `createCheckSummary`, `createErrorSummary`,
  `applyChaos`, `handleChaosInjection`, `handleActionSuccess`,
  `handleActionError`, `isErrorSeverity`, `isWarningSeverity`,
  `SignalerScheduleSchema`, `FitnessSchema`, `SimulationSchema`,
  `CliDefaultsSchema`, `ExecError`.

- **Deleted entirely** (no internal users either):
  `execAbortableOrThrow`, `getColumn`, `findCallExpressions`,
  `findBinaryExpressions`, `findTemplateLiterals`, `isInComment`,
  `countUnescapedBackticks`, `ts` re-export
  (all in `fitness/engine/src/framework/ast-utilities.ts` — the live
  copies now ship in `lang-typescript/src/ast-utilities.ts`),
  `quoteForShell`, `scanDirectiveInventory`,
  `scanDirectiveInventoryFromCache`, `parseLinterIgnoreDirectives`,
  `countAllIgnoreDirectives` and their helpers, `aggregateResults`,
  `passResult`, `filterSignals`, `groupByFile`, `sortSignals`,
  `defaultTargetRegistry`, `loadTargets` (vs the live
  `loadTargetsConfig`), `validateScenarioConfig`, `executeListChecks`
  alias, `executeListRecipes` alias, the unused
  `framework/parse-cache.ts` re-exports
  (`initParseCache`/`clearParseCache`/`getParseTree`/`getParseTreeForFile`
  — call sites import them directly from `@opensip-tools/core`),
  `ARCHITECTURE_DISPLAY` / `DOCUMENTATION_DISPLAY` / `QUALITY_DISPLAY`
  / `RESILIENCE_DISPLAY` / `SECURITY_DISPLAY` / `TESTING_DISPLAY`
  re-exports from each `display/index.ts` barrel (the barrels still
  expose `CHECK_DISPLAY` and `getCheckIcon` / `getCheckDisplayName` —
  the per-category constants are an internal composition detail).

- **Trimmed barrel re-exports** so the public surface matches actual
  consumption: `signalers/index.ts` (now exports only
  `loadSignalersConfig`); `targets/index.ts` (now exports only
  `loadTargetsConfig` and `resolveTargetFiles`).

### Unused exported types (62 → 0)

Most were converted to non-exported (only same-file usage):

- cli UI: `CheckEntry`, `FindingViolation`, `PluginInfo`, `RecipeEntry`,
  `RunHeaderMeta`.
- fitness/engine: `CheckId`, `ExtractSnippetResult`, `PrewarmStats`,
  `MemorySnapshot`, `MemoryProfileSummary`, `GateViolation`,
  `ExplicitCheckSelector`, `PatternCheckSelector`, `TagsCheckSelector`,
  `AllCheckSelector`, `FitnessExecutionOptions`,
  `FitnessReportingOptions`, `RecipeViolation`, `DirectiveInventory`,
  `LinterIgnoreOptions`, `LinterIgnoreResult`, `CheckTargetMap`,
  `PluginsConfig`.
- simulation/engine: `PersonaBehavior`, `PersonaAttributes`,
  `ActionProbabilities`, `ChaosType`, `ChaosInjection`,
  `ChaosTypeConfig`, `LatencyChaosConfig`, `ErrorChaosConfig`,
  `TimeoutChaosConfig`, `RateLimitChaosConfig`,
  `ConnectionDropChaosConfig`, `DataCorruptionChaosConfig`,
  `ExecutionMode`, `SimulationRunStatus`, `ChaosResult`.

Truly-dead types deleted: `ScenarioExecutorResult` (deprecated alias in
`framework-types.ts`; the live discriminated union lives in
`framework/scenario-executor-result.ts`), `RunnableScenario` and
`ScenarioRegistryEntry` re-exports in `framework-types.ts` (the package
barrel imports them directly from `framework/runnable-scenario.ts`),
`SignalerScheduleConfig` (only its own definition referenced),
`SignalersFitnessConfig` / `SignalersSimulationConfig` /
`SignalersCliDefaultsConfig` (no callers — only `SignalersConfig`
escapes the package), `ValidationError` alias in `define-scenario.ts`,
`TargetEntry` and `TargetConfigInput` (only used by the now-removed
`defineTargetConfig`), `SimulationScenario` and `ISimulationService`
and `ListRunsOptions` (no implementations or consumers).

### Duplicate exports (2 → 0)

Removed the redundant `executeListChecks` / `executeListRecipes`
aliases in `packages/fitness/engine/src/cli/list-checks.ts` and
`list-recipes.ts`. Updated the package barrel
(`fitness/engine/src/index.ts`) to re-export only the canonical
`listChecks` / `listRecipes` names.

### Configuration hints (23 → 0)

Rewrote `knip.json`:

- Removed redundant `entry: ["src/index.ts"]` lines for every workspace
  whose `package.json` already points `main` at `dist/index.js`. Knip
  derives the entry from `main` automatically.
- Removed stale `ignore` paths (`docs/**`, `verdaccio-storage/**`,
  `tarballs/**`) — none of those globs matched anything.
- Removed stale `ignoreDependencies` for `@vitest/coverage-v8`,
  `@types/source-map-support`, `source-map-support` (the latter two
  weren't even listed in any `package.json`).

## Public-API rationale

This codebase's public APIs are scoped to the package barrel (each
package's `src/index.ts`). Anything not re-exported from the barrel is
an internal implementation detail. With that frame:

- `getColumn`, `findCallExpressions`, `findBinaryExpressions`,
  `findTemplateLiterals`, `isInComment`, `countUnescapedBackticks`, and
  the `ts` re-export were deleted from
  `fitness/engine/src/framework/ast-utilities.ts` because they are NOT
  re-exported from `@opensip-tools/fitness`'s barrel — third-party check
  authors get them from `@opensip-tools/lang-typescript` instead, which
  has its own `ast-utilities.ts` with the same surface.
- `defineCheck`, `CheckRegistry`, `loadSignalersConfig`,
  `SignalersConfig`, etc. remain exported because they're explicitly
  re-exported from the package barrel and are part of the contract for
  in-tree checks and external consumers (cli, dashboard).

No `// knip-disable` comments were introduced. The two genuine
"can't-statically-detect" cases (runtime-discovered tool/check packages
in cli, dynamic `requireFromHere('js-yaml')` in core) are documented as
`ignoreDependencies` entries in `knip.json` with this summary as the
context document.

## Verification gates

```
$ pnpm -r build      # all 18 workspace projects → Done
$ pnpm -r typecheck  # 0 TS errors
$ pnpm -r test       # 568 total tests passed across 16 packages
$ ./node_modules/.bin/eslint 'packages/**/src/**/*.{ts,tsx}'
  → 0 errors, 7 pre-existing sonarjs/no-duplicate-string warnings
$ ./node_modules/.bin/depcruise packages
  → no dependency violations found (404 modules, 512 dependencies cruised)
$ ./node_modules/.bin/knip
  → exit 0, no output (zero findings)
```

DART parity gate (run from `/Users/breens/Documents/Code/DART-Lite/`):

```
$ npx opensip-tools fit
120 Passed, 0 Failed (0 Errors, 0 Warnings) | Duration 1.4s
```

Matches the baseline captured at the start of the cleanup
(120 Passed / 0 Failed / 0 Errors / 0 Warnings). The DART repo had no
warnings at start, so post-cleanup parity is preserved at the same
counts.
