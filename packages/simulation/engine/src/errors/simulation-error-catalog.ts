/**
 * Simulation-owned error definitions (Plan 00 Phase 5).
 */

import { defineErrorCatalog } from '@opensip-cli/core';

/** Must match packages/simulation/engine/src/tool.ts SIMULATION_STABLE_ID. */
const SIMULATION_OWNER_ID = '715d32c2-692c-4ed4-985b-a35deaf186aa';

export const simulationErrorCatalog = defineErrorCatalog(
  {
    id: SIMULATION_OWNER_ID,
    displayName: 'simulation',
    packageName: '@opensip-cli/simulation',
  },
  {
    'SIMULATION.SCENARIO.ABORTED': {
      code: 'SIMULATION.SCENARIO.ABORTED',
      source: 'application',
      defaultResponsibility: 'user',
      kind: 'cancelled',
      retry: 'never',
      severity: 'error',
      exposure: 'public',
      exitClass: 'cancelled',
      operatorAction: 'Scenario was cancelled. Re-run if the work is still needed.',
      stability: 'public',
      lifecycle: 'active',
      publicMetadataKeys: ['scenarioId'],
    },

    /**
     * A `SimulationRecipe` is missing a required field or carries an unusable execution value.
     *
     * Plan 01 clean break: these ten conditions were `VALIDATION.*` string literals with no
     * catalog entry, surviving only through `legacyFamilyCode`'s head-guessing, so the
     * `tool-author` responsibility — the one fact that says who fixes it — was not
     * machine-readable. One code per (responsibility x kind) cluster per ruling D9; the
     * specific field travels in allowlisted `metadata.field`, because a recipe author fixes
     * every one of them the same way and in the same file.
     */
    'SIMULATION.RECIPE.INVALID': {
      code: 'SIMULATION.RECIPE.INVALID',
      source: 'application',
      defaultResponsibility: 'tool-author',
      kind: 'validation',
      retry: 'never',
      severity: 'error',
      exposure: 'public',
      exitClass: 'plugin-incompatible',
      operatorAction:
        'Correct the named field on the simulation recipe; see the simulation recipe reference for the required shape.',
      stability: 'public',
      lifecycle: 'active',
      publicMetadataKeys: ['field', 'condition'],
    },

    /** A scenario definition is not usable. */
    'SIMULATION.SCENARIO.INVALID': {
      code: 'SIMULATION.SCENARIO.INVALID',
      source: 'application',
      defaultResponsibility: 'tool-author',
      kind: 'validation',
      retry: 'never',
      severity: 'error',
      exposure: 'public',
      exitClass: 'plugin-incompatible',
      operatorAction: 'Correct the scenario configuration; see the scenario reference.',
      stability: 'public',
      lifecycle: 'active',
      publicMetadataKeys: ['field'],
    },

    /**
     * Assertions were evaluated before metrics were set.
     *
     * A builder-ordering violation: `withMetrics` must run first. `tool-author` and `runtime`
     * — no user or operator can act on it, and saying otherwise would be a lie.
     */
    'SIMULATION.METRICS.REQUIRED': {
      code: 'SIMULATION.METRICS.REQUIRED',
      source: 'application',
      defaultResponsibility: 'tool-author',
      kind: 'invariant',
      retry: 'never',
      severity: 'error',
      exposure: 'redacted',
      exitClass: 'runtime',
      operatorAction: 'Call withMetrics(...) before evaluating scenario assertions.',
      stability: 'public',
      lifecycle: 'active',
    },
  },
);
