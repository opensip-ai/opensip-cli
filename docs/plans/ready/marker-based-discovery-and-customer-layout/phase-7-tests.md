# Phase 7: Tests

**Goal:** Cover the work in Phases 0–6 with unit and integration tests.

**Depends on:** All implementation phases.

This phase is a scaffold. Specific test cases, patterns, helpers, and coverage targets would be enriched by plan-improvements Phase 10 in a repo that has the pipeline; in this repo the brief task descriptions below stand in for that detail.

---

## Task 7.1: Unit tests for the generic marker walker

**Files:** [size: M]
- Modify: `packages/core/src/plugins/__tests__/marker-discovery.test.ts`

**Context:** The walker scaffold landed in Phase 0 with a placeholder `it`. This task fills in real cases. Mirror `packages/core/src/plugins/__tests__/tool-package-discovery.test.ts` — that file's fixture pattern (mkdtempSync + makeNodeModulesPackage helper) is the right model.

**Steps:** Cases to cover:
- Finds `fit-pack` marked packages, ignores tools-marked packages.
- Finds `sim-pack` marked packages, ignores `fit-pack` packages.
- Finds both flat and `@scope/`-nested packages.
- Walks ancestor `node_modules/` (pnpm hoisted layout).
- Dedupes by package name across multiple ancestor `node_modules/` (first-occurrence-wins).
- Skips packages with no `package.json`.
- Skips packages with malformed `package.json` (parse error logged at debug).
- Skips packages declaring an unrecognised `opensipTools.kind` value.
- Returns empty when no packages match the requested kind.
- Returns empty when `projectDir` has no `node_modules/`.

**Verification:** `pnpm --filter=@opensip-tools/core test`

**Commit:** `test(core): marker-discovery walker cases`

---

## Task 7.2: Unit tests for `tool-package-discovery` post-refactor

**Files:** [size: S]
- Modify: `packages/core/src/plugins/__tests__/tool-package-discovery.test.ts`

**Context:** Phase 0.2 refactored `tool-package-discovery.ts` to delegate to the generic walker. Existing tests should still pass — this task confirms that by running them and adding one new test that asserts the delegation works correctly (a `kind: "fit-pack"` package is NOT returned by `discoverToolPackages`).

**Steps:** Run existing tests; add the cross-kind exclusion test.

**Verification:** `pnpm --filter=@opensip-tools/core test`

**Commit:** `test(core): confirm tool-package-discovery cross-kind isolation`

---

## Task 7.3: Unit tests for the recipe-registration helper

**Files:** [size: M]
- Modify: `packages/core/src/plugins/__tests__/recipe-loader.test.ts`

**Context:** Scaffold landed in Phase 1. Fill in cases.

**Steps:** Cases to cover:
- Happy path: `mod.recipes` is an array of valid recipes; all register; counter matches array length.
- `mod.recipes` undefined → returns `{ recipesRegistered: 0 }`, no `onWarn` calls.
- `mod.recipes` not an array → same as undefined.
- Recipe missing `id` → `onWarn` emitted with `plugin.recipe.invalid_item` evt; counter does not increment.
- Recipe missing `name` → same as above.
- Recipe is `null` or non-object → same.
- Duplicate recipe → caught as `RecipeAlreadyRegisteredError`; counter does not increment; `onDuplicate` callback invoked if provided.
- Non-duplicate register error (simulate via a registry stub that throws a non-RecipeAlreadyRegisteredError) → re-thrown to caller.
- Multiple recipes, mix of valid + malformed + duplicate → counter reflects only the valid-and-registered count.

**Verification:** `pnpm --filter=@opensip-tools/core test`

**Commit:** `test(core): recipe-loader helper coverage`

---

## Task 7.4: Integration tests for fit's marker discovery + recipe loading

**Files:** [size: M]
- Create: `packages/fitness/engine/src/cli/__tests__/load-discovered-check-packages.test.ts`
- Create: `packages/fitness/engine/src/cli/__tests__/fixtures/fit-pack-marked/` (a fixture pack)
- Create: `packages/fitness/engine/src/cli/__tests__/fixtures/fit-pack-name-pattern/` (a fixture pack at `@opensip-tools/checks-fixture`)
- Create: `packages/fitness/engine/src/cli/__tests__/fixtures/fit-pack-both-paths/` (a pack that matches both)

**Context:** Integration tests that drive `loadDiscoveredCheckPackages` against fixture node_modules layouts. Each fixture pack has a `package.json` and an `index.js` (pre-built JS, not TS — these are runtime fixtures) exporting both `checks` and `recipes`.

**Steps:** Cases to cover:
- A marker-only pack (no name-pattern match) is discovered and its checks + recipes register.
- A name-pattern-only pack (no marker) is discovered (existing behavior).
- A pack matching both paths is loaded **once** (dedupe by name).
- A pack exporting only `checks` (no `recipes`) loads checks and emits `recipesRegistered: 0` in the log event.
- A pack with malformed recipes emits the `plugin.recipe.invalid_item` warning and still registers the valid checks.
- `cli.check_package.loaded` log event carries `recipesRegistered`.

**Verification:** `pnpm --filter=@opensip-tools/fitness test`

**Commit:** `test(fitness): loadDiscoveredCheckPackages marker + recipe coverage`

---

## Task 7.5: Integration tests for sim's marker discovery + helper adoption

**Files:** [size: M]
- Create: `packages/simulation/engine/src/cli/__tests__/load-discovered-scenario-packages.test.ts`
- Create: `packages/simulation/engine/src/cli/__tests__/fixtures/sim-pack-marked/`
- Create: `packages/simulation/engine/src/cli/__tests__/fixtures/sim-pack-name-pattern/`

**Context:** Parallel to Task 7.4 but for sim. Crucially: existing sim tests that assert silent-drop of malformed recipes need updating — now the helper emits a warning. Verify the warning surfaces and the valid recipes still register.

**Steps:** Cases mirror Task 7.4 with scenarios instead of checks.

**Verification:** `pnpm --filter=@opensip-tools/simulation test`

**Commit:** `test(simulation): loadDiscoveredScenarioPackages marker + helper coverage`

---

## Task 7.6: Init scaffolding tests

**Files:** [size: M]
- Modify: `packages/cli/src/commands/__tests__/init.test.ts` (existing tests need updating for the new scaffold output)
- Create: `packages/cli/src/commands/__tests__/init-scaffold-pack.test.ts`
- Create: `packages/cli/src/commands/__tests__/ensure-workspace-globs.test.ts`

**Context:** Phase 5's rewrite of `runScaffold` invalidates many existing init tests. Update those, then add new tests for the new orchestrators.

**Steps:**

1. Update existing init tests:
   - Tests that assert on the exact scaffolded file list need updating to include the new skeleton files (`package.json`, `tsconfig.json`, etc.).
   - Tests that read `example-check.mjs` need updating to `example-check.ts`.
   - Tests for the state classifier's `--keep` / `--remove` flag behavior need re-verifying.

2. New tests for `scaffoldPackSkeleton`:
   - Produces 7 files for the fit domain.
   - Produces 7 files for the sim domain.
   - The `package.json` contains the marker (`opensipTools.kind`).
   - The `index.ts` re-exports `checks` (fit) or `scenarios` (sim) and `recipes`.
   - The `index.ts` does NOT export `metadata`.
   - The example check imports from `@opensip-tools/fitness` (not relative path).

3. New tests for `ensureWorkspaceGlobs`:
   - Creates `pnpm-workspace.yaml` if absent (and `pnpm-lock.yaml` exists or no other workspace file).
   - Appends to existing `pnpm-workspace.yaml` if `opensip-tools/*` not already listed.
   - No-op if `opensip-tools/*` already listed.
   - Appends to `package.json#workspaces` array if that's the existing convention.

**Verification:** `pnpm --filter=@opensip-tools/cli test`

**Commit:** `test(cli): init pack-skeleton scaffold + workspace-globs coverage`

---

## Task 7.7: Template emitter unit tests

**Files:** [size: M]
- Create: `packages/cli/src/commands/init/pack-templates/__tests__/*.test.ts` (one per template)

**Context:** Scaffolds landed in Phase 5.1. Fill in real assertions: emitted strings are syntactically valid (JSON / TypeScript), contain the expected marker / domain identifiers, don't reference removed contract fields (no `metadata`).

**Steps:** Per-template assertions:
- `package-json.ts` — emitted string parses as JSON; contains `opensipTools.kind`; matches the requested domain.
- `tsconfig-json.ts` — parses as JSON; minimal sanity (compilerOptions present, outDir 'dist').
- `vitest-config.ts` — non-empty TypeScript that imports `defineConfig` from `vitest/config`.
- `index-ts.ts` — re-exports `checks` (fit) or `scenarios` (sim) and `recipes`; does NOT export `metadata`.
- `example-check.ts` / `example-scenario.ts` — imports the appropriate `define*` function; uses the correct kind.
- `example-recipe.ts` — imports the appropriate `defineRecipe` function.
- `readme-md.ts` — non-empty markdown.

**Verification:** `pnpm --filter=@opensip-tools/cli test`

**Commit:** `test(cli): pack-template emitter assertions`

---

## Task 7.8: Confirm dependency-cruiser sees no new violations

**Files:** [size: XS]
- (no edits expected; verification only — if violations appear, fix the offending import)

**Context:** Phases 3 and 4 add new `@opensip-tools/core` imports from fitness and simulation. These are canonical (downstream → upstream) — dependency-cruiser should allow. Phase 5 adds new files in `packages/cli/src/commands/init/` — also downstream. Confirm no violations.

**Steps:** Run `pnpm depcruise` and confirm 0 violations.

**Verification:** `pnpm lint`

**Commit:** (no commit unless a fix is needed)

---

## Phase 7 End-to-End Verification

- `pnpm test` — entire workspace green.
- `pnpm lint` — 0 errors across ESLint + dependency-cruiser.
- Coverage spot check: every new file from Phases 0–5 has at least one test referencing its public API.

> **Deferred:** Coverage targets — no specific % coverage threshold is set. A human reviewer should confirm the test list above is sufficient or call out gaps.
