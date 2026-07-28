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
    'FIT.NOT_FOUND.RECIPE': {
      code: 'FIT.NOT_FOUND.RECIPE',
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
    'FIT.CHECK.UNKNOWN': {
      code: 'FIT.CHECK.UNKNOWN',
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
      publicMetadataKeys: ['check', 'condition'],
    },
    'FIT.FITNESS.SESSION_IN_PROGRESS': {
      code: 'FIT.FITNESS.SESSION_IN_PROGRESS',
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
    'FIT.FITNESS.CHECK_ERROR': {
      code: 'FIT.FITNESS.CHECK_ERROR',
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
    /**
     * A check's external command outlived its configured timeout.
     *
     * Distinct from `CHECK_ABORTED` because ADR-0183 requires cancelled and timed-out to stay
     * distinguishable, and because the operator does something different: a cancellation is
     * something they DID, a deadline breach means the check needs a longer budget or the
     * command is stuck. Both used to raise `CheckAbortedError`, so a timeout reported itself as
     * "the check was cancelled. Re-run if the work is still needed." — advice that describes
     * the wrong event and exits `cancelled` (130) rather than a runtime failure.
     */
    'FIT.FITNESS.CHECK_DEADLINE_EXCEEDED': {
      code: 'FIT.FITNESS.CHECK_DEADLINE_EXCEEDED',
      source: 'application',
      defaultResponsibility: 'user',
      kind: 'timeout',
      retry: 'transient',
      severity: 'error',
      exposure: 'public',
      exitClass: 'runtime',
      operatorAction:
        "The check's command exceeded its timeout. Raise the check's `timeout` if the work legitimately takes longer, or investigate why the command is not completing.",
      stability: 'public',
      lifecycle: 'active',
      publicMetadataKeys: ['checkId'],
    },

    'FIT.FITNESS.CHECK_ABORTED': {
      code: 'FIT.FITNESS.CHECK_ABORTED',
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
    'FIT.FITNESS.FILE_TOO_LARGE': {
      code: 'FIT.FITNESS.FILE_TOO_LARGE',
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
      publicMetadataKeys: ['actualBytes', 'condition', 'maxBytes'],
    },

    /**
     * A caller asked to analyze a path outside the resolved target set, or asked to read a
     * directory as a file.
     *
     * `security` for the containment case: the target set is the boundary of what a run is
     * allowed to read, and honouring a path outside it would widen the scan silently.
     */
    'FIT.FITNESS.PATH_REJECTED': {
      code: 'FIT.FITNESS.PATH_REJECTED',
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
    'FIT.FITNESS.ENGINE_STATE_INVALID': {
      code: 'FIT.FITNESS.ENGINE_STATE_INVALID',
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
    'FIT.FITNESS.EXEC_FAILED': {
      code: 'FIT.FITNESS.EXEC_FAILED',
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
      publicMetadataKeys: ['condition', 'errno'],
    },

    /** A command-mode check's optional executable is absent from PATH. */
    'FIT.EXEC.BINARY_MISSING': {
      code: 'FIT.EXEC.BINARY_MISSING',
      source: 'external',
      defaultResponsibility: 'environment',
      kind: 'not-found',
      retry: 'never',
      severity: 'warning',
      exposure: 'public',
      exitClass: 'success',
      operatorAction: 'Install the executable required by this optional check and retry.',
      stability: 'public',
      lifecycle: 'active',
      publicMetadataKeys: ['errno'],
    },

    /**
     * A `targets:` or `signalers:` block in `opensip-cli.config.yml` is unusable, or a check
     * names a target the config does not define.
     *
     * The `ERRORS.` head these carried was mapped by nothing, so the most common
     * config-authoring mistake in the product reported as an operator-only internal fatal
     * saying "report a bug" — for a typo the user could have fixed in ten seconds. `user` /
     * `configuration` / `public` is the whole point of registering it.
     *
     * One code (D9): every member is fixed in the same file, and `metadata.field` names the
     * block and `metadata.condition` whether it was missing, unknown, or invalid.
     */
    'FIT.FIT_SCOPE.INVALID': {
      code: 'FIT.FIT_SCOPE.INVALID',
      source: 'application',
      defaultResponsibility: 'user',
      kind: 'validation',
      retry: 'never',
      severity: 'error',
      exposure: 'public',
      exitClass: 'configuration',
      operatorAction:
        'Correct the named targets or signalers block in opensip-cli.config.yml; `opensip fit list` shows the targets a check can reference.',
      stability: 'public',
      lifecycle: 'active',
      publicMetadataKeys: ['field', 'condition'],
    },

    /**
     * A project plugin or check pack could not be admitted or loaded.
     *
     * One clustered definition (D9): both branches are external capability components with
     * the same recovery. `condition` identifies plugin vs check-pack; `component` identifies
     * the declared source without promoting the loader's free-text detail to public output.
     */
    'FIT.LOAD.COMPONENT_FAILED': {
      code: 'FIT.LOAD.COMPONENT_FAILED',
      source: 'external',
      defaultResponsibility: 'environment',
      kind: 'compatibility',
      retry: 'caller-policy',
      severity: 'error',
      exposure: 'public',
      exitClass: 'runtime',
      operatorAction:
        'Verify the fitness plugin or check pack is installed, compatible, and declared correctly.',
      stability: 'public',
      lifecycle: 'active',
      publicMetadataKeys: ['condition', 'component'],
    },

    /**
     * A fitness capability worker request named a check the pack does not export.
     */
    'FIT.CAPABILITY.CHECK_NOT_FOUND': {
      code: 'FIT.CAPABILITY.CHECK_NOT_FOUND',
      source: 'external',
      defaultResponsibility: 'tool-author',
      kind: 'not-found',
      retry: 'never',
      severity: 'error',
      exposure: 'public',
      exitClass: 'plugin-incompatible',
      operatorAction:
        'Correct the capability pack contribution so its advertised check id is exported.',
      stability: 'public',
      lifecycle: 'active',
      publicMetadataKeys: ['packageName', 'checkId'],
    },

    /**
     * A fitness capability worker received a request kind it does not implement.
     */
    'FIT.CAPABILITY.UNKNOWN_WORKER_REQUEST': {
      code: 'FIT.CAPABILITY.UNKNOWN_WORKER_REQUEST',
      source: 'application',
      defaultResponsibility: 'tool-author',
      kind: 'invariant',
      retry: 'never',
      severity: 'error',
      exposure: 'public',
      exitClass: 'runtime',
      operatorAction:
        'Ensure the host and fit-pack worker share the same opensip-cli build, then report the unknown worker request if it recurs.',
      stability: 'public',
      lifecycle: 'active',
      publicMetadataKeys: ['condition'],
    },
  },
);
