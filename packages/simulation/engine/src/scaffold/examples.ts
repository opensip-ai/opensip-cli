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
// 'sim' is a standalone driver: you bring the target. This demo keeps the
// generated file dependency-free so it runs immediately after \`opensip init\`,
// while still returning the same load-kind result shape the helper API emits.
// To test YOUR service, replace the body of run() with calls to a target you own.
//
// Edit this file or add new .mjs files to opensip-cli/sim/scenarios/.
// Files in this directory are auto-loaded on the next \`opensip sim\` run.
//
// Docs: https://github.com/opensip-ai/opensip-cli#simulation

const LOW_ERROR_RATE = {
  metric: 'error_rate',
  operator: 'lt',
  value: 0.05,
  message: 'Error rate must be < 5.0%',
};

const LOW_P95_LATENCY = {
  metric: 'p95_latency_ms',
  operator: 'lt',
  value: 500,
  message: 'P95 latency must be < 500ms',
};

function sleep(ms, abortSignal) {
  return new Promise((resolve, reject) => {
    if (abortSignal.aborted) {
      reject(new Error('Scenario aborted'));
      return;
    }
    let settled = false;
    let timer;
    const finish = () => {
      if (settled) return;
      settled = true;
      abortSignal.removeEventListener('abort', abort);
      resolve();
    };
    const abort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error('Scenario aborted'));
    };
    timer = setTimeout(finish, ms);
    abortSignal.addEventListener('abort', abort, { once: true });
  });
}

function percentile(values, ratio) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * ratio));
  return sorted[index] ?? 0;
}

export const scenarios = [
  {
    kind: 'load',
    id: 'example-scenario',
    name: 'example-scenario',
    description: 'Demo load scenario — drives a trivial in-process target',
    tags: ['example'],
    async run(abortSignal) {
      const startedAt = Date.now();
      const latencies = [];

      for (let i = 0; i < 20; i += 1) {
        const requestStartedAt = Date.now();
        await sleep(5, abortSignal);
        latencies.push(Date.now() - requestStartedAt);
        await sleep(10, abortSignal);
      }

      const totalRequests = latencies.length;
      const avgLatencyMs =
        totalRequests === 0
          ? 0
          : latencies.reduce((sum, latency) => sum + latency, 0) / totalRequests;
      const metrics = {
        totalRequests,
        successfulRequests: totalRequests,
        failedRequests: 0,
        avgLatencyMs,
        p50LatencyMs: percentile(latencies, 0.5),
        p95LatencyMs: percentile(latencies, 0.95),
        p99LatencyMs: percentile(latencies, 0.99),
        errorsGenerated: 0,
      };

      return {
        kind: 'load',
        scenarioId: 'example-scenario',
        passed: true,
        durationMs: Date.now() - startedAt,
        signals: [],
        outcome: {
          metrics,
          assertions: {
            passed: [LOW_ERROR_RATE, LOW_P95_LATENCY],
            failed: [],
          },
        },
      };
    },
  },
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

export const recipes = [
  {
    id: 'URCP_sim_example',
    name: 'example',
    displayName: 'Example',
    description: 'Demo recipe — runs only the example scenario',
    scenarios: { type: 'explicit', scenarioIds: ['example-scenario'] },
    execution: { mode: 'parallel', timeout: 30_000 },
  },
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
