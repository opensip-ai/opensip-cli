// Fixture sim scenario pack (installed-artifact platform acceptance). Unlike a
// fit-pack (marker discovery via `opensipTools.kind`), the `sim-pack` marker was
// RETIRED: the simulation tool discovers scenario packs by name-pattern
// (`@opensip-cli/scenarios-*`) and by the explicit project-local config list. So
// this package declares NO `opensipTools` marker — it is installed via `opensip
// sim plugin add <tarball>` (which records it in the sim domain's config list)
// and loaded by name; the loader then walks its `scenarios` / `recipes` exports
// and registers ONE scenario + ONE recipe.
//
// Authored against the installed `@opensip-cli/simulation` so it goes through
// the real `defineLoadScenario` / `defineSimulationRecipe` API (and therefore
// resolves the same `@opensip-cli/simulation` + `@opensip-cli/core` the engine
// uses — exercising the single-engine load path, exactly as the fit-pack
// fixture exercises the single-core path via `defineCheck`).
//
// The scenario drives a trivial, deterministic, ZERO-NETWORK in-process target
// that resolves immediately, so it runs to a clean pass with no external
// dependency or network. The unique scenario/recipe ids let the acceptance
// journey narrow a `sim --recipe sim-pack-fixture` run to exactly this
// contribution and prove it was loaded — and prove it is gone after removal.
import { ASSERTIONS, defineLoadScenario, defineSimulationRecipe } from '@opensip-cli/simulation';

/**
 * Deterministic in-process target. Resolving counts as a successful request;
 * honouring the abort signal keeps scenario abort / `abort` faults correct.
 */
const inProcessTarget = async (ctx) => {
  if (ctx.signal.aborted) throw new Error('sim-pack fixture target aborted');
};

export const scenarios = [
  defineLoadScenario({
    id: 'sim-pack-fixture-scenario',
    name: 'sim-pack-fixture-scenario',
    description: 'Fixture sim-pack scenario: drives a trivial in-process target',
    tags: ['fixture'],
    target: inProcessTarget,
    workload: { rps: 1 },
    duration: 1,
    assertions: [ASSERTIONS.lowErrorRate()],
  }),
];

export const recipes = [
  defineSimulationRecipe({
    id: 'URCP_sim_pack_fixture',
    name: 'sim-pack-fixture',
    displayName: 'Sim Pack Fixture',
    description: 'Fixture recipe: runs only the sim-pack fixture scenario',
    scenarios: { type: 'explicit', scenarioIds: ['sim-pack-fixture-scenario'] },
    execution: { mode: 'parallel', timeout: 30_000 },
  }),
];
