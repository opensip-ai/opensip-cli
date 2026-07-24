/**
 * Fitness-owned error definitions (Plan 00 Phase 5 representative catalog).
 * Owner id matches FITNESS_STABLE_ID in tool.ts.
 */

import { defineErrorCatalog } from '@opensip-cli/core';

/** Must match packages/fitness/engine/src/tool.ts FITNESS_STABLE_ID. */
const FITNESS_OWNER_ID = 'afd68bd3-ff3c-4935-a5b6-76d8fc7a5224';

export const fitnessErrorCatalog = defineErrorCatalog(
  {
    id: FITNESS_OWNER_ID,
    displayName: 'fitness',
    packageName: '@opensip-cli/fitness',
  },
  {
    'RESOURCE.NOT_FOUND.RECIPE': {
      code: 'RESOURCE.NOT_FOUND.RECIPE',
      source: 'application',
      defaultResponsibility: 'user',
      kind: 'not-found',
      retry: 'never',
      severity: 'error',
      exposure: 'public',
      exitClass: 'not-found',
      operatorAction: 'Run opensip fit recipes to list available recipes.',
      stability: 'public',
      lifecycle: 'active',
      publicMetadataKeys: ['entity', 'identifier'],
    },
    'CONFIG.UNKNOWN_CHECK': {
      code: 'CONFIG.UNKNOWN_CHECK',
      source: 'application',
      defaultResponsibility: 'user',
      kind: 'validation',
      retry: 'never',
      severity: 'error',
      exposure: 'public',
      exitClass: 'configuration',
      operatorAction: 'Run opensip fit list to see available checks.',
      stability: 'public',
      lifecycle: 'active',
      publicMetadataKeys: ['check'],
    },
    'SYSTEM.FITNESS.SESSION_IN_PROGRESS': {
      code: 'SYSTEM.FITNESS.SESSION_IN_PROGRESS',
      source: 'application',
      defaultResponsibility: 'tool-author',
      kind: 'conflict',
      retry: 'never',
      severity: 'error',
      exposure: 'public',
      exitClass: 'runtime',
      operatorAction: 'Wait for the active fitness session to finish or abort it.',
      stability: 'internal',
      lifecycle: 'active',
    },
  },
  { allowLegacyCodes: true },
);
