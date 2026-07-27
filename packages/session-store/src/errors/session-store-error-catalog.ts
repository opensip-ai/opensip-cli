/**
 * `@opensip-cli/session-store` error definitions (Plan 01).
 *
 * A substrate catalog under ruling D1: the owner id is the npm package name.
 *
 * Twenty-two literals across the run/step/session read and write paths become five
 * definitions. The clustering follows the one distinction that actually changes what anyone
 * does: is the CALLER's request wrong, or is the STORED EVIDENCE wrong?
 *
 * That split was invisible before. Everything here used the `VALIDATION.` or `SYSTEM.` head,
 * so a caller passing a bad offset and a persisted row that no longer parses reported the same
 * way — even though one is fixed in the caller and the other means recorded evidence is
 * unreadable and the run that produced it should be re-run.
 */

import { defineErrorCatalog } from '@opensip-cli/core';

import type { ErrorDefinition } from '@opensip-cli/core';

/** Substrate catalogs are keyed on the npm package name (ruling D1). */
export const SESSION_STORE_ERROR_OWNER_ID = '@opensip-cli/session-store';

/** The caller's request is unusable. Nothing is wrong with what is stored. */
const CALLER_REQUEST = {
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

/**
 * Stored evidence cannot be read back. `integrity` and `environment`: the caller did nothing
 * wrong, and the recovery is about the data on disk rather than about the request.
 */
const STORED_EVIDENCE = {
  source: 'infrastructure',
  defaultResponsibility: 'environment',
  kind: 'integrity',
  retry: 'never',
  severity: 'error',
  exposure: 'public',
  exitClass: 'runtime',
  stability: 'public',
  lifecycle: 'active',
} as const satisfies Omit<ErrorDefinition, 'owner' | 'code' | 'operatorAction'>;

export const sessionStoreErrorCatalog = defineErrorCatalog(
  {
    id: SESSION_STORE_ERROR_OWNER_ID,
    displayName: '@opensip-cli/session-store',
    packageName: SESSION_STORE_ERROR_OWNER_ID,
  },
  {
    /**
     * A run, step or session record a caller asked to WRITE is not a usable shape: a bad id,
     * timestamp, ordinal, attempt, context manifest, host-metrics block, or a step whose run id
     * does not match the run it is being attached to.
     *
     * One code (D9) — a caller fixes every one of them in the value it passed, and
     * `metadata.field` names which. Refusing at the boundary is what keeps the store readable
     * later: a record admitted with a malformed timestamp becomes an unreadable row forever.
     */
    'SESSION.WRITE.RECORD_INVALID': {
      ...CALLER_REQUEST,
      code: 'SESSION.WRITE.RECORD_INVALID',
      operatorAction:
        'Correct the named field on the run, step or session record before persisting it.',
      publicMetadataKeys: ['field', 'condition'],
    },

    /**
     * A read bound is unusable — a limit, offset, purge cutoff or maintenance batch size that
     * is not a non-negative integer.
     *
     * Refused rather than clamped: a purge with a silently-substituted cutoff would delete a
     * different set of rows than the caller asked to delete, which is not a failure anyone
     * would want papered over.
     */
    'SESSION.READ.BOUND_INVALID': {
      ...CALLER_REQUEST,
      code: 'SESSION.READ.BOUND_INVALID',
      operatorAction:
        'Pass a non-negative integer for the named bound; omit it to accept the built-in default.',
      publicMetadataKeys: ['field'],
    },

    /** A caller asked for a tool the store has no records for. */
    'SESSION.READ.UNKNOWN_TOOL': {
      ...CALLER_REQUEST,
      code: 'SESSION.READ.UNKNOWN_TOOL',
      kind: 'not-found',
      operatorAction:
        'Use a tool name that has recorded sessions; `opensip tools list` shows them.',
      publicMetadataKeys: ['field'],
    },

    /**
     * A stored record cannot be read back: a session payload that is missing or no longer
     * parses, a linked session that is gone, or evidence that will not serialize.
     *
     * This is the code that says "the evidence is unreadable", which no consumer could
     * distinguish before. The action is about the DATA, not the request.
     */
    'SESSION.EVIDENCE.UNREADABLE': {
      ...STORED_EVIDENCE,
      code: 'SESSION.EVIDENCE.UNREADABLE',
      operatorAction:
        'Stored evidence for this run could not be read. Re-run the tool to regenerate it, or purge the affected sessions.',
      publicMetadataKeys: ['condition', 'field'],
    },

    /**
     * A legacy stored row carries a value this version refuses to trust — an id or working
     * directory that predates the current safety rules.
     *
     * `security`, separate from `UNREADABLE`: the row parses fine, and the refusal is a
     * containment decision about acting on an unvalidated path or identifier from an older
     * schema. Reading it as mere corruption would invite "just repair it", which is exactly
     * what must not happen here.
     */
    'SESSION.EVIDENCE.UNSAFE_LEGACY_VALUE': {
      ...STORED_EVIDENCE,
      code: 'SESSION.EVIDENCE.UNSAFE_LEGACY_VALUE',
      kind: 'security',
      operatorAction:
        'A stored record predates current safety rules and was refused. Purge the affected sessions; they cannot be migrated in place.',
      publicMetadataKeys: ['condition', 'field'],
    },
  },
);
