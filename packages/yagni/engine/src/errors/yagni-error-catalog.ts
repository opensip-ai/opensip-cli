/** YAGNI-owned error definitions (Plan 01 Wave 3). */

import { defineErrorCatalog } from '@opensip-cli/core';

/** Must match YAGNI_STABLE_ID in tool.ts. */
const YAGNI_OWNER_ID = '3aba9195-2297-4f20-99d5-906945092dfc';

export const yagniErrorCatalog = defineErrorCatalog(
  {
    id: YAGNI_OWNER_ID,
    displayName: 'yagni',
    packageName: '@opensip-cli/yagni',
  },
  {
    /** A detector crashed while producing its advisory evidence. */
    'YAGNI.DETECTOR.EXECUTION_FAILED': {
      code: 'YAGNI.DETECTOR.EXECUTION_FAILED',
      source: 'application',
      defaultResponsibility: 'tool-author',
      kind: 'invariant',
      retry: 'never',
      severity: 'error',
      exposure: 'redacted',
      exitClass: 'runtime',
      operatorAction: 'Capture the run id and report the failing detector to its author.',
      stability: 'public',
      lifecycle: 'active',
      publicMetadataKeys: ['detector'],
    },

    /** An explicit detector selector named no registered detector. */
    'YAGNI.DETECTOR.NOT_FOUND': {
      code: 'YAGNI.DETECTOR.NOT_FOUND',
      source: 'application',
      defaultResponsibility: 'user',
      kind: 'not-found',
      retry: 'never',
      severity: 'error',
      exposure: 'public',
      exitClass: 'not-found',
      operatorAction: 'Use a detector slug listed by the YAGNI command help.',
      stability: 'public',
      lifecycle: 'active',
      publicMetadataKeys: ['detector'],
    },
  },
);
