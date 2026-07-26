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

    // --- Plan 01 clean break -------------------------------------------------------------
    // Twelve codes below were bare string literals with no catalog entry, alive only through
    // `legacyFamilyCode`'s head-guessing. Registering them is what makes their axes real
    // instead of inferred from the first token of the code.

    /**
     * A check threw, or was aborted, during execution.
     *
     * `warning` severity and a `success` exit class: ruling D7 — one check failing must not
     * destroy the verdict the other 225 produced. The run reports the check as errored and
     * continues, which is what the engine already did; the definition now says so.
     */
    'SYSTEM.FITNESS.CHECK_ERROR': {
      code: 'SYSTEM.FITNESS.CHECK_ERROR',
      source: 'application',
      defaultResponsibility: 'tool-author',
      kind: 'invariant',
      retry: 'never',
      severity: 'warning',
      exposure: 'public',
      exitClass: 'success',
      operatorAction:
        'A check failed to run; its findings are missing from this report. Report it to the check author.',
      stability: 'public',
      lifecycle: 'active',
      publicMetadataKeys: ['checkId'],
    },

    /** A check was cancelled — the interruption, not a check defect (ruling D5). */
    'SYSTEM.FITNESS.CHECK_ABORTED': {
      code: 'SYSTEM.FITNESS.CHECK_ABORTED',
      source: 'application',
      defaultResponsibility: 'user',
      kind: 'cancelled',
      retry: 'never',
      severity: 'warning',
      exposure: 'public',
      exitClass: 'cancelled',
      operatorAction: 'The check was cancelled. Re-run if the work is still needed.',
      stability: 'public',
      lifecycle: 'active',
      publicMetadataKeys: ['checkId'],
    },

    /**
     * A file exceeds the size bound the analyzer will read.
     *
     * `resource`, not `validation` — the bound is an anti-DoS work limit over untrusted input.
     * `warning` / `success` for the same D7 reason as CHECK_ERROR: one oversized file must not
     * fail the whole scan, it must be reported as not analyzed.
     */
    'SYSTEM.FITNESS.FILE_TOO_LARGE': {
      code: 'SYSTEM.FITNESS.FILE_TOO_LARGE',
      source: 'application',
      defaultResponsibility: 'user',
      kind: 'resource',
      retry: 'never',
      severity: 'warning',
      exposure: 'public',
      exitClass: 'success',
      operatorAction:
        'The named file is larger than opensip will analyze and was skipped. Exclude it from the target set, or split it.',
      stability: 'public',
      lifecycle: 'active',
      publicMetadataKeys: ['maxBytes'],
    },

    /**
     * A caller asked to analyze a path outside the resolved target set, or asked to read a
     * directory as a file.
     *
     * `security` for the containment case: the target set is the boundary of what a run is
     * allowed to read, and honouring a path outside it would widen the scan silently.
     */
    'VALIDATION.FITNESS.PATH_REJECTED': {
      code: 'VALIDATION.FITNESS.PATH_REJECTED',
      source: 'application',
      defaultResponsibility: 'tool-author',
      kind: 'security',
      retry: 'never',
      severity: 'error',
      exposure: 'public',
      exitClass: 'runtime',
      operatorAction:
        'Analyze only paths from the resolved target set; a path outside it, or a directory, is refused.',
      stability: 'public',
      lifecycle: 'active',
      publicMetadataKeys: ['condition'],
    },

    /**
     * The engine was called in a state it cannot run in: no session, a session already in
     * progress, a missing per-run file cache, a missing fitness subscope, or an analysis mode
     * outside the closed set.
     *
     * One clustered code (D9) — every one of them is a host or engine wiring bug with the same
     * audience and the same non-action, and `redacted` says so honestly rather than inventing
     * an operator step that does not exist.
     */
    'SYSTEM.FITNESS.ENGINE_STATE_INVALID': {
      code: 'SYSTEM.FITNESS.ENGINE_STATE_INVALID',
      source: 'application',
      defaultResponsibility: 'tool-author',
      kind: 'invariant',
      retry: 'never',
      severity: 'error',
      exposure: 'redacted',
      exitClass: 'runtime',
      operatorAction: 'Capture the run id and report a bug; the fitness engine was misdriven.',
      stability: 'public',
      lifecycle: 'active',
      publicMetadataKeys: ['condition'],
    },

    /**
     * An external command the engine shells out to could not be run, or was given no command.
     *
     * `external` source: the failure is the other program's, and the operator's action is about
     * that program's availability rather than about opensip.
     */
    'SYSTEM.FITNESS.EXEC_FAILED': {
      code: 'SYSTEM.FITNESS.EXEC_FAILED',
      source: 'external',
      defaultResponsibility: 'environment',
      kind: 'I/O',
      retry: 'caller-policy',
      severity: 'error',
      exposure: 'public',
      exitClass: 'runtime',
      operatorAction:
        'The external command could not be executed. Check that it is installed and on PATH, then retry.',
      stability: 'public',
      lifecycle: 'active',
      publicMetadataKeys: ['condition'],
    },
  },
  { allowLegacyCodes: true },
);
