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
  },
  { allowLegacyCodes: true },
);
