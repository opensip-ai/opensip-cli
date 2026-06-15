/**
 * @fileoverview simulation's `init` example contribution (ADR-0038).
 *
 * simulation OWNS the example scenario/recipe bytes that `init` scaffolds —
 * relocated here from the CLI's `config-templates.ts`. sim's examples are
 * language-independent, so the `ScaffoldContext` is ignored. Byte content is
 * verbatim; a Phase-0 golden + a Phase-1 parity test pin byte-identity.
 */

import type { ScaffoldContext, ScaffoldFile } from '@opensip-cli/core';

/** Example simulation scenario source (verbatim). */
export function exampleScenarioSource(): string {
  return `// Example simulation scenario — a real load window against an in-process target.
//
// 'sim' is a standalone driver: you bring the target. This demo drives a
// trivial in-process target so it runs out-of-box and shows the harness
// mechanics (a real request loop, measured latency, asserted SLOs). To test
// YOUR service, replace 'target' with httpTarget({ url: process.env.TARGET_URL })
// — and point it only at a target you own. For fault injection, see the chaos
// docs (defineChaosScenario + fault.*).
//
// Edit this file or add new .mjs files to opensip-cli/sim/scenarios/.
// Files in this directory are auto-loaded on the next \`opensip sim\` run.
//
// Docs: https://github.com/opensip-ai/opensip-cli#simulation
import { defineLoadScenario, ASSERTIONS /*, httpTarget */ } from '@opensip-cli/simulation';

export const scenarios = [
  defineLoadScenario({
    id: 'example-scenario',
    name: 'example-scenario',
    description: 'Demo load scenario — drives a trivial in-process target',
    tags: ['example'],
    // BYO target: any async function that resolves on success / throws on failure.
    // Swap for your service:  target: httpTarget({ url: process.env.TARGET_URL }),
    target: async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    },
    workload: { rps: 20, rampUp: 1 },
    duration: 3,
    assertions: [ASSERTIONS.lowErrorRate(), ASSERTIONS.lowLatency('p95', 500)],
  }),
];
`;
}

/** Example simulation recipe source (verbatim). */
export function exampleSimRecipeSource(): string {
  return `// Example simulation recipe — runs only the example scenario.
//
// Edit this file or add new .mjs files to opensip-cli/sim/recipes/.
// Files in this directory are auto-loaded on the next run.
//
// Run this recipe explicitly:  opensip sim --recipe example
import { defineSimulationRecipe } from '@opensip-cli/simulation';

export const recipes = [
  defineSimulationRecipe({
    id: 'URCP_sim_example',
    name: 'example',
    displayName: 'Example',
    description: 'Demo recipe — runs only the example scenario',
    scenarios: { type: 'explicit', scenarioIds: ['example-scenario'] },
    execution: { mode: 'parallel', timeout: 30_000 },
  }),
];
`;
}

/**
 * simulation's scaffold contribution — language-independent (`ctx` ignored):
 * `scenarios/example-scenario.mjs` + `recipes/example-recipe.mjs`, matching
 * `scaffold-writer.ts`'s sim logic.
 */
export function simScaffoldExamples(_ctx: ScaffoldContext): ScaffoldFile[] {
  return [
    {
      kind: 'scenarios',
      filename: 'example-scenario.mjs',
      content: exampleScenarioSource(),
      stableId: 'example-scenario',
    },
    {
      kind: 'recipes',
      filename: 'example-recipe.mjs',
      content: exampleSimRecipeSource(),
      stableId: 'URCP_sim_example',
    },
  ];
}

/** simulation's COMPLETE stable example-id set (language-independent). */
export function simStableExampleIds(): string[] {
  return ['example-scenario', 'URCP_sim_example'];
}
