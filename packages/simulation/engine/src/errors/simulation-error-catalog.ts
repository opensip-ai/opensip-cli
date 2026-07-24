/**
 * Simulation-owned error definitions (Plan 00 Phase 5).
 */

import { defineErrorCatalog } from '@opensip-cli/core';

export const simulationErrorCatalog = defineErrorCatalog(
  {
    id: 'simulation',
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
