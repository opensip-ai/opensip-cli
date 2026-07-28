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

    /**
     * A detector descriptor fails the defineDetector contract (id/slug/description).
     *
     * One code (D9); `metadata.condition` names which field failed.
     */
    'YAGNI.DETECTOR.INVALID_DEFINITION': {
      code: 'YAGNI.DETECTOR.INVALID_DEFINITION',
      source: 'application',
      defaultResponsibility: 'tool-author',
      kind: 'validation',
      retry: 'never',
      severity: 'error',
      exposure: 'public',
      exitClass: 'plugin-incompatible',
      operatorAction:
        'Correct the detector id (kebab-case), slug (yagni:<id>), or non-empty description.',
      stability: 'public',
      lifecycle: 'active',
      publicMetadataKeys: ['condition', 'detectorId'],
    },

    /**
     * The clone-detection substrate returned a duplicate group with no members.
     */
    'YAGNI.INVARIANT.EMPTY_DUPLICATE_GROUP': {
      code: 'YAGNI.INVARIANT.EMPTY_DUPLICATE_GROUP',
      source: 'application',
      defaultResponsibility: 'tool-author',
      kind: 'invariant',
      retry: 'never',
      severity: 'error',
      exposure: 'redacted',
      exitClass: 'runtime',
      operatorAction:
        'Capture the run id and report the empty duplicate group to the clone-detection author.',
      stability: 'public',
      lifecycle: 'active',
    },

    /**
     * A stored yagni session cannot be replayed because its payload is missing.
     */
    'YAGNI.SESSION.PAYLOAD_MISSING': {
      code: 'YAGNI.SESSION.PAYLOAD_MISSING',
      source: 'infrastructure',
      defaultResponsibility: 'environment',
      kind: 'integrity',
      retry: 'caller-policy',
      severity: 'error',
      exposure: 'public',
      exitClass: 'runtime',
      operatorAction: 'Re-run yagni to capture a session with a replay payload, then retry.',
      stability: 'public',
      lifecycle: 'active',
      publicMetadataKeys: ['condition'],
    },
  },
);
