# Marker-Based Plugin Discovery + Customer Pack-Layout Plan

Introduce marker-based discovery (`opensipTools.kind: "fit-pack" | "sim-pack"`) so customers can ship fit/sim packs under any npm scope, fix fit's auto-discovery to load `mod.recipes` like sim already does, kill the dead `metadata` plugin export, and rewrite `init` to scaffold a real workspace package per domain (`opensip-tools/fit/` and `opensip-tools/sim/` as `@<scope>/fit` and `@<scope>/sim`).

## Problem

Today the platform forces customers into uncomfortable choices and quietly drops half a contract:

1. **Name-pattern-only discovery for customer packs.** `packages/fitness/engine/src/plugins/check-package-discovery.ts:42` hardcodes `DEFAULT_SCOPE = '@opensip-tools'` and `packages/simulation/engine/src/plugins/scenario-package-discovery.ts:42-43` does the same. Customers wanting auto-discovery must either name-squat on the platform scope (a footgun — they hit npm 403 on publish) or thread their scope through `plugins.packageScopes`. Tool plugins, by contrast, are discovered via a marker (`opensipTools.kind: "tool"` at `packages/core/src/plugins/tool-package-discovery.ts:33`) — that asymmetry has no architectural justification.

2. **Fit's auto-discovery silently drops `recipes`.** `packages/fitness/engine/src/cli/fit.ts:261-263` casts the imported pack to `{ checks?, checkDisplay? }` — `mod.recipes` is never read. `FitPluginExports` (`packages/fitness/engine/src/plugins/types.ts:17`) explicitly allows `recipes?: readonly FitnessRecipe[]`. Customers who export both find their checks work but their recipes report "Unknown recipe." Sim's parallel `loadDiscoveredScenarioPackages` (`packages/simulation/engine/src/cli/sim.ts:188-201`) loads recipes correctly. Fit was missed.

3. **Three near-identical recipe-registration sites.** Once Phase 3 lands, fit's CLI auto-discovery is the *third* near-copy of recipe-shape-check-+-try-register-with-silent-duplicate-skip. The existing two (`packages/fitness/engine/src/plugins/loader.ts:109-127` and `packages/simulation/engine/src/cli/sim.ts:188-201`) already diverge: loader.ts warns on malformed items, sim.ts drops them silently. Without consolidation, a fourth site is one PR away.

4. **Dead `metadata` plugin export across every first-party pack.** `FitPluginExports.metadata?`, `SimPluginExports.metadata?`, `LangPluginExports.metadata?` and the `PluginMetadata` type (`packages/core/src/plugins/types.ts:42-48`) are part of the contract. Every first-party check pack (`checks-typescript`, `checks-universal`, `checks-python`, `checks-go`, `checks-java`, `checks-cpp`, `checks-rust`) faithfully exports `metadata` at its `src/index.ts`. **Nothing reads it.** A repo-wide grep for `mod.metadata | exports.metadata | plugin.metadata | fit.metadata | sim.metadata` returns zero consumer sites. Every field (`name`, `version`, `author`, `description`, `homepage`) is duplicated from `package.json` — already read separately by `readCheckPackageMetadata`.

5. **`init` scaffolds a layout that doesn't match the recommended customer layout.** `packages/cli/src/commands/init.ts:1-13` scaffolds `opensip-tools/fit/checks/example-check.mjs` and friends as loose `.mjs` files. The recommended customer layout (locked in this design) is "the directory IS a workspace npm package": `opensip-tools/fit/package.json` (with marker), `tsconfig.json`, `vitest.config.ts`, `index.ts`, plus example checks/recipes as TypeScript files. Today's customer either hand-writes that skeleton or stays with loose files indefinitely.

## Target State

After this plan:

- A generic marker walker in core: `discoverPackagesByMarker(projectDir, kind)` at `packages/core/src/plugins/marker-discovery.ts`. Walks ancestor `node_modules/` directories, scans top-level entries and one level into `@scope/` directories, returns packages whose `package.json` declares `opensipTools.kind === kind`. `tool-package-discovery.ts` is refactored to call this with `kind: "tool"` and stays as a thin domain-typed wrapper. Three marker kinds recognized: `'tool'`, `'fit-pack'`, `'sim-pack'`.

- `loadDiscoveredCheckPackages` and `loadDiscoveredScenarioPackages` each call the existing name-pattern walker AND the new marker walker, dedupe by package name (first occurrence wins), and load each pack once. Existing `@opensip-tools/checks-*` and `@opensip-tools/scenarios-*` discovery continues working unchanged. Existing `plugins.packageScopes` continues working unchanged.

- A shared `registerRecipesFromMod<R>(mod, registry, options)` in core, generic over recipe type `R`, called from three sites:
  - `packages/fitness/engine/src/plugins/loader.ts` (existing call site — refactored to use the helper)
  - `packages/fitness/engine/src/cli/fit.ts` (new call — replaces the silent drop)
  - `packages/simulation/engine/src/cli/sim.ts` (refactored to use the helper)

  The helper carries loader.ts's careful pattern — recipes failing the shape check (`'id' in recipe && 'name' in recipe`) emit a `plugin.recipe.invalid_item` warning; the catch around `registry.register` narrows to the registry's typed duplicate error and re-throws anything else. The "fourth copy" pressure disappears.

- `metadata` field removed from `FitPluginExports`, `SimPluginExports`, `LangPluginExports`. `PluginMetadata` type removed from core. `export const metadata = ...` removed from every first-party check pack's `src/index.ts`. No metadata scaffolded by `init`.

- `opensip-tools init` scaffolds, per domain (fit + sim):
  - `opensip-tools/<domain>/package.json` — `{ "name": "<placeholder-or-detected-scope>/<domain>", "private": true, "type": "module", "opensipTools": { "kind": "<domain>-pack" }, "main": "./dist/index.js", "scripts": {...}, "devDependencies": {...} }`
  - `opensip-tools/<domain>/tsconfig.json`
  - `opensip-tools/<domain>/vitest.config.ts`
  - `opensip-tools/<domain>/index.ts` — re-exports `checks` (fit) or `scenarios` (sim) and `recipes` arrays
  - `opensip-tools/<domain>/checks/example-check.ts` (fit) / `opensip-tools/<domain>/scenarios/example-scenario.ts` (sim) — TypeScript example
  - `opensip-tools/<domain>/recipes/example-recipe.ts` — TypeScript example
  - `opensip-tools/<domain>/README.md` — minimal authoring guidance

  And at the repo root, `init` ensures `pnpm-workspace.yaml` (or `package.json` workspaces) includes `opensip-tools/*`. If the repo doesn't have a workspace setup at all, init creates one.

- `init`'s state classifier grows from "config + dir presence" to also detect "is `opensip-tools/<domain>/` already a workspace package?" The `--keep` / `--remove` flags continue to express user intent for non-pristine states.

- Plugin-authoring docs (`docs/architecture/70-surfaces/02-plugin-authoring.md`) significantly rewritten: section 4 ("A check pack (publishable)") now describes the directory-IS-the-package model as the recommended path. Marker pattern documented as first-class. `packageScopes` soft-deprecated in docs — kept in code, called out as "compat for legacy third-party packs that follow `@scope/checks-*` naming without declaring the marker." The Three Paths enumeration becomes Four Paths (adds marker).

- CLI command-tree docs (`docs/architecture/70-surfaces/01-cli-command-tree.md`) updated for `init`'s new scaffold output.

## Design Principles

**Additive discovery, not replacement.** This is the one place where the skill's "no backwards compatibility" default does not apply — confirmed in Step 0. Marker-based discovery runs in parallel with the existing name-pattern walk and the `plugins.packageScopes` mechanism. Dedupe by package name when both find the same on-disk module. Customers using the legacy paths keep working unchanged; the new path is the recommended one going forward.

**Walker lives in core.** The discovery primitive — "walk ancestor `node_modules/` looking for packages whose `package.json` declares `opensipTools.kind === X`" — is shared across three tools today (fit, sim, tool plugins) and is exactly the kind of primitive that belongs in `packages/core/src/plugins/` per CLAUDE.md's layering rules. The existing `tool-package-discovery.ts` is refactored to call the generic walker instead of duplicating it.

**Recipe-registration converges on the careful pattern.** Loader.ts's pattern (warn on malformed, narrow catch around duplicate, return typed counts) becomes the single implementation. Sim's looser pattern (silent malformed drop, unqualified catch swallowing all register errors) is fixed by adoption, not preserved. The shared helper is the migration path.

**Customer pack location is conventional, not load-bearing.** opensip-tools doesn't *load* anything from `opensip-tools/<domain>/` directly — discovery still flows through `node_modules/` walking + marker matching. The directory layout is a *recommended convention* customers can deviate from. `init`'s scaffolding produces the recommended shape; the runtime tolerates other shapes.

**Plan-improvements pipeline.** `docs/ai-helpers/prompts/plan-improvements/plan-improvements.md` does not exist in this repo. Architectural compliance, observability event-name policy, hardening posture, audit, and cross-cutting instrumentation are *not* exhaustively addressed in this draft and will need a human review pass before merge. Each phase that touches a concern owned by a pipeline phase carries a `> Deferred:` blockquote naming what's missing.

## Phases

| Phase | Name | Description | Depends On |
|-------|------|-------------|------------|
| 0 | Generic marker walker | `discoverPackagesByMarker(projectDir, kind)` in core; refactor `tool-package-discovery.ts` to delegate. | — |
| 1 | Recipe-registration helper | `registerRecipesFromMod<R>(...)` in core; pure utility (no walker dep). | — |
| 2 | Contract cleanup (kill `metadata`) | Remove `metadata?` field from `FitPluginExports` / `SimPluginExports` / `LangPluginExports`; remove `PluginMetadata` from core; remove `export const metadata` from every first-party check pack. | — |
| 3 | Fit marker discovery + recipe loading | Wire marker walk into `loadDiscoveredCheckPackages`; load recipes via helper; refactor loader.ts to use the helper too. | 0, 1, 2 |
| 4 | Sim marker discovery + helper adoption | Wire marker walk into `loadDiscoveredScenarioPackages`; migrate existing recipe-loading to use the helper. | 0, 1, 2 |
| 5 | Init rewrite | Full per-domain package skeleton scaffolding; workspace-globs update; revise the state classifier. | 2 |
| 6 | Docs | Significant rewrite of section 4 in `02-plugin-authoring.md`; CLI command-tree update; soft-deprecate `packageScopes`. | 3, 4, 5 |
| 7 | Tests | Unit tests for marker walker + recipe helper; integration tests for fit + sim marker discovery; init scaffolding tests for the new package skeleton. | 3, 4, 5 |
| 8 | Validation | End-to-end smoke against real Vitest harness + manual `init` run, `pnpm install`, `opensip-tools fit`, `opensip-tools sim` against a scaffolded project. | All |

## Dependency Graph

```
Phase 0 (Generic marker walker)  ───┐
                                    │
Phase 1 (Recipe helper)            ─┼─→ Phase 3 (Fit) ──┐
                                    │                   │
Phase 2 (Kill metadata)            ─┘─→ Phase 4 (Sim) ──┤
                                       └─→ Phase 5 (Init)
                                                          │
                                                          ↓
                                                       Phase 6 (Docs)
                                                          │
                                                          ↓
                                                       Phase 7 (Tests)
                                                          │
                                                          ↓
                                                       Phase 8 (Validation)
```

Phases 0, 1, 2 are independent and can land in any order or in parallel — none modifies the same file as another. Phases 3 and 4 depend on 0+1+2 but are independent of each other (different packages). Phase 5 depends on Phase 2 (so it doesn't scaffold the killed `metadata` field) but is independent of 0/1/3/4. Phase 6 reflects the locked design from 3+4+5. Phases 7 and 8 are sequenced as Tests → Validation per the skill format.

## File Change Summary

| Phase | New Files | Modified Files |
|-------|-----------|----------------|
| 0 | `packages/core/src/plugins/marker-discovery.ts`, `packages/core/src/plugins/__tests__/marker-discovery.test.ts` | `packages/core/src/plugins/tool-package-discovery.ts` (refactor to delegate), `packages/core/src/plugins/index.ts` (export), `packages/core/src/index.ts` (re-export) |
| 1 | `packages/core/src/plugins/recipe-loader.ts`, `packages/core/src/plugins/__tests__/recipe-loader.test.ts` | `packages/core/src/plugins/index.ts`, `packages/core/src/index.ts` |
| 2 | — | `packages/core/src/plugins/types.ts` (remove `PluginMetadata`, `metadata` from `LangPluginExports`), `packages/fitness/engine/src/plugins/types.ts` (remove `metadata` from `FitPluginExports`), `packages/simulation/engine/src/plugins/types.ts` (remove `metadata` from `SimPluginExports`), `packages/fitness/checks-typescript/src/index.ts`, `packages/fitness/checks-universal/src/index.ts`, `packages/fitness/checks-python/src/index.ts`, `packages/fitness/checks-go/src/index.ts`, `packages/fitness/checks-java/src/index.ts`, `packages/fitness/checks-cpp/src/index.ts`, `packages/fitness/checks-rust/src/index.ts` |
| 3 | — | `packages/fitness/engine/src/cli/fit.ts` (marker walk + recipe loading via helper), `packages/fitness/engine/src/plugins/loader.ts` (adopt helper) |
| 4 | — | `packages/simulation/engine/src/cli/sim.ts` (marker walk + helper adoption) |
| 5 | `packages/cli/src/commands/init/scaffold-pack-skeleton.ts`, `packages/cli/src/commands/init/pack-templates/*.ts` (per-domain templates) | `packages/cli/src/commands/init.ts` (state classifier + new scaffold path), `packages/cli/src/commands/init/templates.ts` (or equivalent template host file) |
| 6 | — | `docs/architecture/70-surfaces/02-plugin-authoring.md`, `docs/architecture/70-surfaces/01-cli-command-tree.md` |
| 7 | `packages/fitness/engine/src/cli/__tests__/loadDiscoveredCheckPackages.test.ts` (or similar), `packages/simulation/engine/src/cli/__tests__/loadDiscoveredScenarioPackages.test.ts`, `packages/cli/src/commands/__tests__/init-scaffold-pack.test.ts`, fixture packs under `__tests__/fixtures/` for each | Several existing tests if they assert the killed `metadata` export |
| 8 | `packages/cli/src/__tests__/e2e-marker-discovery.test.ts` | — |

## Critical Files Reference

| File | Role | Key Structures |
|------|------|----------------|
| `packages/core/src/plugins/tool-package-discovery.ts` | Canonical marker-based discovery walker. Phase 0 generalises the body into `discoverPackagesByMarker(projectDir, kind)` and leaves this file as a thin `{ kind: 'tool' }` wrapper. | `discoverToolPackages(options)` (line 57), `collectFromNodeModules(...)` (line 77), `isToolPackage(packageDir)` (line 107), `TOOL_KIND` constant (line 33) |
| `packages/fitness/engine/src/plugins/check-package-discovery.ts` | Existing name-pattern + `packageScopes` discovery for fit packs. Phase 3 keeps it intact; the new marker walk runs alongside in `cli/fit.ts`. | `discoverCheckPackages(options)` (line 77), `resolveScopes(...)` (now in core via prior FU-3 work), `readCheckPackagePreferences(projectDir)` (line 194) |
| `packages/fitness/engine/src/cli/fit.ts` | The fit CLI entry. `loadDiscoveredCheckPackages` is the asymmetry site — drops `mod.recipes` today. Phase 3's central edit. | `loadDiscoveredCheckPackages(projectDir)` (line 244), module cast at line 261, checks loop line 266-276, log event `cli.check_package.loaded` line 279-284 |
| `packages/fitness/engine/src/plugins/loader.ts` | The other recipe-registration site (project-local `.mjs` + `plugins.fit` listings). Phase 3 refactors to use the new helper. | `registerFitExports(...)` (line ~56), recipes loop at lines 109-127 with the careful malformed-warning pattern |
| `packages/simulation/engine/src/cli/sim.ts` | The sim CLI entry. `loadDiscoveredScenarioPackages` already loads recipes — but with the looser silent-drop pattern. Phase 4 migrates it to the helper. | `loadDiscoveredScenarioPackages(projectDir)` (line 167), recipes loop at lines 188-201, log event `cli.scenario_package.loaded` line 203-209 |
| `packages/simulation/engine/src/plugins/scenario-package-discovery.ts` | Existing name-pattern + `packageScopes` discovery for sim packs. Phase 4 keeps it intact alongside marker walk. | `discoverScenarioPackages(options)` (line ~77), `readScenarioPackagePreferences(projectDir)` (line 194) |
| `packages/fitness/engine/src/plugins/types.ts` | `FitPluginExports` contract. Phase 2 removes the `metadata?` field. | `FitPluginExports` (line 15), removed: `metadata?: PluginMetadata` (line 18) |
| `packages/simulation/engine/src/plugins/types.ts` | `SimPluginExports` contract. Phase 2 removes the `metadata?` field. | `SimPluginExports` (line ~22) |
| `packages/core/src/plugins/types.ts` | Holds `PluginMetadata` type and `LangPluginExports.metadata?`. Phase 2 removes both. | `PluginMetadata` (line 42-48), `LangPluginExports` (line 28-32) |
| `packages/fitness/checks-typescript/src/index.ts` | A first-party check pack. Phase 2 removes the `export const metadata` block. Same pattern for the six other first-party packs. | `export const metadata = {...}` block (line 30-35) |
| `packages/cli/src/commands/init.ts` | The init command. Phase 5 substantially rewrites the scaffold path. | `executeInit(args)` (line 878), `classifyWorkingDir(paths)` (line 479), `runScaffold(...)` (line 827), template emitters (lines 286-400) |
| `packages/fitness/engine/src/recipes/types.ts` | Defines `FitnessRecipe`. Phase 1's helper is generic but the shape check requires the recipe to have `id` and `name`. | `FitnessRecipe` (line 95) |
| `packages/simulation/engine/src/recipes/types.ts` | Defines `SimulationRecipe`. | `SimulationRecipe` (verified line via earlier grep) |
| `packages/fitness/engine/src/recipes/registry.ts` | `defaultRecipeRegistry` and `FitnessRecipeRegistry` (extends generic `RecipeRegistry<R>` from core). | `defaultRecipeRegistry` (line 140), `FitnessRecipeRegistry` (line 46) |
| `packages/simulation/engine/src/recipes/registry.ts` | `defaultSimulationRecipeRegistry` and `SimulationRecipeRegistry`. | `defaultSimulationRecipeRegistry` (line 77), `SimulationRecipeRegistry` (line 26) |
| `docs/architecture/70-surfaces/02-plugin-authoring.md` | Customer-facing plugin authoring doc. Section 4 is rewritten in Phase 6. | "## 4. A check pack (publishable)" header, "### Where should this package live in your repo?" subsection (added in FU-2-revision) |

### Files this plan creates (greenfield)

| File | Role | Key Structures (planned) |
|------|------|--------------------------|
| `packages/core/src/plugins/marker-discovery.ts` (new — Phase 0) | Generic marker-based discovery walker. Becomes the substrate for `tool`, `fit-pack`, `sim-pack` (and any future kind). | `MarkerKind = 'tool' \| 'fit-pack' \| 'sim-pack'`, `DiscoveredMarkerPackage`, `discoverPackagesByMarker({ projectDir, kind })`, internal `collectFromNodeModules`, `readMarkerKind` |
| `packages/core/src/plugins/recipe-loader.ts` (new — Phase 1) | Shared recipe-registration helper. Carries loader.ts's malformed-warning + narrow-catch pattern. | `registerRecipesFromMod<R>(mod, registry, options): { recipesRegistered: number }`, `RegisterRecipesOptions` (namespace, onWarn) |
| `packages/cli/src/commands/init/scaffold-pack-skeleton.ts` (new — Phase 5) | Per-domain package-skeleton scaffolder called from `init`. | `scaffoldPackSkeleton({ domain, paths, language, force }): readonly ScaffoldedFile[]` |
| `packages/cli/src/commands/init/pack-templates/<domain>-*.ts` (new — Phase 5) | Per-file template emitters for `package.json`, `tsconfig.json`, `vitest.config.ts`, `index.ts`, example check/scenario, example recipe, README. One per file kind, parameterized by domain. | Per-file template functions returning `{ path, contents }` |

## Per-Task Verification Standard

At the end of every task, run:

```bash
pnpm build && pnpm typecheck && pnpm test
```

`pnpm lint` (ESLint + dependency-cruiser, both must be 0-error) at the end of each phase.

Phase-specific verification commands are listed in each phase file.

## Pipeline-deferred concerns

Because `docs/ai-helpers/prompts/plan-improvements/plan-improvements.md` does not exist in this repo, the following cross-cutting concerns are *not* exhaustively addressed in this draft and must be revisited before merge:

- **Architectural compliance invariants.** Dependency-cruiser must catch any new layering violations. The marker walker MUST live in `packages/core/src/plugins/`; fitness and simulation calling sites MUST NOT depend on each other. Verify `.dependency-cruiser.cjs` is unchanged at PR review.
- **Observability event-name catalog.** New / changed log events proposed: `cli.check_package.loaded` (extended with `recipesRegistered`), `cli.scenario_package.loaded` (existing), `plugin.recipe.invalid_item` (new — emitted by the shared helper on shape-check failure). Broader event-name policy needs human review.
- **Hardening posture.** Marker walker reads JSON from arbitrary `node_modules/*/package.json`. Existing pattern in `tool-package-discovery.ts` already handles parse failure via try/catch + debug log; the generalised walker inherits the same safety.
- **Audit trail.** No new state-mutating writes. Audit obligations unchanged.
- **Customer-facing copy review.** Phase 5 introduces a substantial customer-facing surface (the scaffolded `package.json` `name` placeholder, README templates, init's success message). Flag for human review before merge.
- **Test coverage targets.** Phase 7 lists test files but doesn't enumerate cases. A human reviewer should confirm coverage hits the failure modes (malformed pack `package.json`, missing entry point, marker on a non-pack package, dedup collision between name-pattern and marker walks).
