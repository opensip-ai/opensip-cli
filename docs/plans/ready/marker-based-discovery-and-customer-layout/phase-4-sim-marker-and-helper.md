# Phase 4: Sim marker discovery + helper adoption

**Goal:** Wire marker-based discovery into `loadDiscoveredScenarioPackages` alongside the existing name-pattern walk; migrate the existing inline recipe-loading to the shared helper. After this phase, sim and fit have symmetric discovery surfaces.

**Depends on:** Phases 0 (marker walker), 1 (recipe helper), 2 (contract cleanup).

---

## Task 4.1: Wire marker discovery into `loadDiscoveredScenarioPackages`

**Files:** [size: M]
- Modify: `packages/simulation/engine/src/cli/sim.ts`

**Context:** `loadDiscoveredScenarioPackages` at line 167 mirrors fit's structure: reads preferences (line 169), calls name-pattern walker (line 170-175), iterates discovered packs, imports each, loads scenarios (which self-register on import, measured by registry size delta at lines 183/187), then loads `mod.recipes` with the silent-drop pattern at lines 188-201, and logs `cli.scenario_package.loaded` (line 203-209).

This task adds the marker walk alongside (parallel to Phase 3 in fit) and replaces the inline recipe loop with a call to the helper.

**Steps:**

1. Add imports:
   ```typescript
   import { discoverPackagesByMarker, registerRecipesFromMod } from '@opensip-tools/core';
   ```
   (Some are likely already imported via other paths — verify.)

2. After the existing `discoverScenarioPackages` call (line 170-175), add the marker walk + dedupe:
   ```typescript
   const markerDiscovered = discoverPackagesByMarker({ projectDir, kind: 'sim-pack' });
   const seenNames = new Set(discovered.map((p) => p.name));
   const allPacks = [
     ...discovered,
     ...markerDiscovered
       .filter((p) => !seenNames.has(p.name))
       .map((p) => ({ name: p.name, packageDir: p.packageDir })),
   ];
   ```
   Replace `for (const pkg of discovered)` (line 176) with `for (const pkg of allPacks)`.

3. Replace the inline recipe-loading block (lines 188-201) with:
   ```typescript
   const { recipesRegistered } = registerRecipesFromMod(mod, defaultSimulationRecipeRegistry, {
     namespace: pkg.name,
     onWarn: (evt, message, extra) => {
       logger.warn({ evt, module: 'cli:sim', name: pkg.name, msg: message, ...(extra ?? {}) });
     },
   });
   ```

4. The existing `logger.info` for `cli.scenario_package.loaded` (line 203-209) already includes `recipesRegistered` — no change needed.

5. The existing module cast on line 185 (`as SimPluginExports`) is fine since `SimPluginExports.recipes?` already typed the field correctly. No expansion needed (in contrast with fit, which had an inline anonymous cast).

**Wiring:** `loadDiscoveredScenarioPackages` is called once per CLI sim invocation. No call-site changes outside this function.

**Verification:**
```bash
pnpm --filter=@opensip-tools/simulation build
pnpm --filter=@opensip-tools/simulation typecheck
pnpm --filter=@opensip-tools/simulation test
```

**Commit:** `feat(simulation): marker-based discovery + shared recipe helper adoption in sim CLI`

---

## Phase 4 End-to-End Verification

- `pnpm --filter=@opensip-tools/simulation test` — green. Existing tests that assert silent-drop behavior on malformed recipes may now see warnings instead — those assertions need updating (now: warning emitted via `onWarn`; before: nothing).
- `pnpm typecheck` — green.
- `pnpm lint` — 0 errors. Dependency-cruiser: `packages/simulation/engine` may now import from `@opensip-tools/core` (already does; just one more symbol).
- Manual smoke (deferred to Phase 8): scaffold a fixture pack with `opensipTools.kind: "sim-pack"` exporting both scenarios and recipes, install it, confirm both register.

> **Deferred:** Observability — sim now warns instead of silently dropping malformed recipes. A pack that was previously silently broken becomes visibly broken (warning surfaces). This is a behavior change but in the customer-friendly direction; flag in release notes.
