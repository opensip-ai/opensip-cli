/**
 * `@opensip-cli/datastore` error definitions (Plan 01).
 *
 * A substrate catalog under ruling D1: the owner id is the npm package name.
 *
 * Two distinct audiences, and the split matters. `DATASTORE.OPEN.*` is a CALLER contract —
 * a tool asked the factory for a SQLite store without saying where — while the `RECORD_*`
 * bounds are anti-DoS work limits over data a tool supplies at write time. Neither is
 * anything an end user can act on, so both are `tool-author`; conflating them with the user's
 * own configuration (which the retired `CONFIGURATION.` / `VALIDATION.` heads implied) sent
 * operators looking in the wrong file.
 */

import { defineErrorCatalog } from '@opensip-cli/core';

import type { ErrorDefinition } from '@opensip-cli/core';

/** Substrate catalogs are keyed on the npm package name (ruling D1). */
export const DATASTORE_ERROR_OWNER_ID = '@opensip-cli/datastore';

const CALLER_CONTRACT = {
  source: 'application',
  defaultResponsibility: 'tool-author',
  kind: 'validation',
  retry: 'never',
  severity: 'error',
  exposure: 'public',
  exitClass: 'runtime',
  stability: 'public',
  lifecycle: 'active',
} as const satisfies Omit<ErrorDefinition, 'owner' | 'code' | 'operatorAction'>;

export const datastoreErrorCatalog = defineErrorCatalog(
  {
    id: DATASTORE_ERROR_OWNER_ID,
    displayName: '@opensip-cli/datastore',
    packageName: DATASTORE_ERROR_OWNER_ID,
  },
  {
    /** The SQLite backend was requested with no `path`. */
    'DATASTORE.OPEN.MISSING_PATH': {
      ...CALLER_CONTRACT,
      code: 'DATASTORE.OPEN.MISSING_PATH',
      operatorAction:
        'Pass a `path` when opening the SQLite backend, or use the in-memory backend which needs none.',
      publicMetadataKeys: ['field'],
    },

    /**
     * A caller supplied a read bound that is not usable — a non-positive or non-integer limit.
     *
     * Refused rather than clamped: substituting a default for an unusable bound silently
     * returns a different result set than the caller asked for, and a caller that asked for
     * `-1` rows has a bug worth surfacing rather than papering over.
     */
    'DATASTORE.READ.BOUND_INVALID': {
      ...CALLER_CONTRACT,
      code: 'DATASTORE.READ.BOUND_INVALID',
      operatorAction: 'Pass a positive integer limit; omit it to accept the built-in default.',
      publicMetadataKeys: ['field'],
    },

    /**
     * A record a tool asked to persist exceeds its bound — an individual field, the serialized
     * JSON, or a tool-state payload.
     *
     * `resource`, not `validation`: these bounds exist to keep one tool from filling the
     * shared datastore, so hitting one is exhaustion of a deliberate budget rather than a
     * malformed value. One code for all three (D9) — same audience, same fix, and
     * `metadata.field` says which bound was hit.
     */
    'DATASTORE.WRITE.RECORD_TOO_LARGE': {
      ...CALLER_CONTRACT,
      code: 'DATASTORE.WRITE.RECORD_TOO_LARGE',
      kind: 'resource',
      operatorAction:
        'Reduce the size of the named field or payload before persisting it; the datastore bound protects shared storage.',
      publicMetadataKeys: ['field', 'bound'],
    },
  },
);
