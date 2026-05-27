# Phase 3: Fit marker discovery + recipe loading

**Goal:** Wire marker-based discovery into `loadDiscoveredCheckPackages` alongside the existing name-pattern walk; add recipe loading via the new helper; refactor `plugins/loader.ts` to call the helper too. After this phase, fit's auto-discovery loads checks AND recipes from packs found via name-pattern OR marker.

**Depends on:** Phases 0 (marker walker), 1 (recipe helper), 2 (contract cleanup).

---

## Task 3.1: Wire marker discovery + recipe loading into `loadDiscoveredCheckPackages`

**Files:** [size: M]
- Modify: `packages/fitness/engine/src/cli/fit.ts`

**Context:** `loadDiscoveredCheckPackages` at line 244 currently:
1. Reads `plugins.checkPackages` / `autoDiscoverChecks` / `packageScopes` preferences (line 245).
2. Calls `discoverCheckPackages(...)` — the name-pattern + scope walker (line 246-251).
3. Iterates discovered packs; for each, imports the module and casts to `{ checks?, checkDisplay? }` (line 261-264).
4. Registers checks from `mod.checks` (line 266-276).
5. Merges `mod.checkDisplay` (line 278).
6. Logs `cli.check_package.loaded` with `checksRegistered` (line 279-284).
7. **Drops `mod.recipes` silently.**

This task adds:
- A second discovery call using `discoverPackagesByMarker({ projectDir, kind: 'fit-pack' })` from `@opensip-tools/core`.
- A union-and-dedupe step: name-pattern packs first, then marker packs whose names weren't already seen.
- A recipe-loading step using `registerRecipesFromMod` with `defaultRecipeRegistry` (from `../recipes/registry.js`).
- Expansion of the module-cast type to include `recipes`.
- A `recipesRegistered` field on the existing `cli.check_package.loaded` log event.

**Steps:**

1. Add imports at the top of `fit.ts`:
   ```typescript
   import { discoverPackagesByMarker, registerRecipesFromMod, logger } from '@opensip-tools/core';
   import { defaultRecipeRegistry } from '../recipes/registry.js';
   ```
   (Some of these are likely already imported — check before duplicating.)

2. In `loadDiscoveredCheckPackages`, after the existing `discoverCheckPackages` call (line 246-251), add:
   ```typescript
   const markerDiscovered = discoverPackagesByMarker({ projectDir, kind: 'fit-pack' });
   const seenNames = new Set(discovered.map((p) => p.name));
   const allPacks = [
     ...discovered,
     ...markerDiscovered
       .filter((p) => !seenNames.has(p.name))
       .map((p) => ({ name: p.name, packageDir: p.packageDir })),
   ];
   ```
   Replace the existing `for (const pkg of discovered)` (line 253) with `for (const pkg of allPacks)`.

3. Expand the module cast inside the loop:
   ```typescript
   const mod = (await import(moduleUrl)) as {
     checks?: unknown;
     checkDisplay?: unknown;
     recipes?: unknown;
   };
   ```

4. After the checks loop (line 266-276) and the `mergeCheckDisplay` call (line 278), add the recipe-loading call:
   ```typescript
   const { recipesRegistered } = registerRecipesFromMod(mod, defaultRecipeRegistry, {
     namespace: pkg.name,
     onWarn: (evt, message, extra) => {
       logger.warn({ evt, module: 'cli:fit', name: pkg.name, msg: message, ...(extra ?? {}) });
     },
   });
   ```

5. Update the existing `logger.info({ evt: 'cli.check_package.loaded', ... })` call (line 279-284) to include `recipesRegistered`:
   ```typescript
   logger.info({
     evt: 'cli.check_package.loaded',
     module: 'cli:fit',
     name: pkg.name,
     checksRegistered: registered,
     recipesRegistered,
   });
   ```

**Wiring:**

`loadDiscoveredCheckPackages` is called from `ensureChecksLoaded` (around line 165 of fit.ts) which is invoked at the top of every fit-command action. The discovery anchor (`projectDir`) is resolved by `ProjectContext` upstream. No call-site changes outside this function.

**Verification:**
```bash
pnpm --filter=@opensip-tools/fitness build
pnpm --filter=@opensip-tools/fitness typecheck
pnpm --filter=@opensip-tools/fitness test
```

**Commit:** `feat(fitness): marker-based discovery + recipe loading in fit CLI`

---

## Task 3.2: Refactor `plugins/loader.ts` to use the shared helper

**Files:** [size: S]
- Modify: `packages/fitness/engine/src/plugins/loader.ts`

**Context:** `loader.ts:109-127` is the existing careful recipe-registration site. It's called for project-local `.mjs` plugins and for any package listed under `plugins.fit` in `opensip-tools.config.yml`. The shape-check + try-register + malformed-warning pattern is exactly what Phase 1's helper extracted. This task replaces the inline implementation with a call to the helper, preserving behavior.

A subtlety: loader.ts uses `ctx.warn(evt, message, extra)` — a structured warning channel on the loader context. The helper takes a generic `onWarn` callback. The migration adapts: `onWarn: (evt, message, extra) => ctx.warn(evt, message, extra)`.

**Steps:**

1. Import the helper at the top of `loader.ts`:
   ```typescript
   import { registerRecipesFromMod } from '@opensip-tools/core';
   ```

2. Replace the recipe-loop block (lines 109-127) with:
   ```typescript
   const { recipesRegistered: helperRecipesRegistered } = registerRecipesFromMod(fit, defaultRecipeRegistry, {
     namespace: ctx.plugin.namespace,
     onWarn: (evt, message, extra) => ctx.warn(evt, message, extra),
   });
   recipesRegistered += helperRecipesRegistered;
   ```

   The local `recipesRegistered` accumulator (from line 56 in `registerFitExports`) stays — it sums helper output with anything tallied earlier in the function.

3. Verify nothing else in `loader.ts` referenced the deleted block's local variables. The shape-check function was inlined; if any other call site in this file used it, surface that and refactor (unlikely — the shape check was specific to the recipe loop).

**Wiring:** Behavior preserved. The helper emits the same warning string (the `evt` name changes from `plugin.loader.invalid_recipe_item` to `plugin.recipe.invalid_item` — flagged in release notes).

**Verification:**
```bash
pnpm --filter=@opensip-tools/fitness build
pnpm --filter=@opensip-tools/fitness test
```

The existing tests for `loader.ts` (likely `packages/fitness/engine/src/plugins/__tests__/loader.test.ts`) must continue passing. If a test asserts on the exact `evt` name `plugin.loader.invalid_recipe_item`, update it to `plugin.recipe.invalid_item` — the new canonical name from the helper.

**Commit:** `refactor(fitness): plugins/loader.ts adopts shared recipe helper`

---

## Phase 3 End-to-End Verification

- `pnpm --filter=@opensip-tools/fitness test` — green.
- `pnpm typecheck` — green.
- `pnpm lint` — 0 errors. Dependency-cruiser: `packages/fitness/engine` may now import from `@opensip-tools/core` for the marker walker and recipe helper. Verify the cruiser rules allow this (they should — fitness → core is the canonical direction).
- Manual smoke (deferred to Phase 8): scaffold a fixture pack that declares `opensipTools.kind: "fit-pack"`, install it into a project's node_modules, run `opensip-tools fit-list` and confirm the pack's checks appear; run `opensip-tools fit --recipe <pack-recipe>` and confirm it executes.

> **Deferred:** Observability — the `recipesRegistered` field on `cli.check_package.loaded` is new. Consumers querying this log event for trend analysis will see the field appear; flag in release notes.
