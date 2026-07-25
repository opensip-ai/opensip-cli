/**
 * Runtime-coordination error definitions (Plan 01 Wave 1).
 *
 * `runtime-lease.ts` today raises ~150 conditions under **two** legacy codes,
 * `SYSTEM.RUNTIME_COORDINATION.UNSAFE` and `…BUSY`, both of which resolve through
 * `legacyFamilyCode`'s `SYSTEM` head to `SYSTEM_ERROR`: kind `invariant`, retry `never`,
 * responsibility `tool-author`, operator action "report a bug". That is wrong for almost
 * every one of them — routine contention, recoverable persisted-state corruption, a
 * transient `lstat` errno and a genuine containment violation are not the same failure and
 * cannot be told apart by an operator or by a `--json` consumer.
 *
 * The split below follows the ledger's per-site judgements. Each definition is a
 * (responsibility × kind) cluster per ruling D9; the specific branch travels in
 * allowlisted `metadata`, never in a new code.
 */

import type { ErrorDefinition } from '../../error-definition.js';

/** Definitions keyed by code, ready to fold into the core catalog. */
export const runtimeCoordinationDefinitions = {
  /**
   * Another holder is doing the same work right now.
   *
   * `RuntimeSnapshotChangedError` exists precisely to mean transient contention, yet its
   * legacy code inherited `retry: 'never'` — the module's own retry loop had to
   * special-case the class because the definition said the opposite. `transient` retry
   * and `environment` responsibility make that loop's behaviour readable from the code.
   */
  'CORE.RUNTIME_COORDINATION.BUSY': {
    code: 'CORE.RUNTIME_COORDINATION.BUSY',
    source: 'infrastructure',
    defaultResponsibility: 'environment',
    kind: 'conflict',
    retry: 'transient',
    severity: 'error',
    exposure: 'public',
    exitClass: 'runtime',
    operatorAction:
      'Another opensip run is holding this coordination record. Wait for it to finish, or re-run — this resolves itself.',
    stability: 'public',
    lifecycle: 'active',
    publicMetadataKeys: ['condition', 'dimension'],
  },

  /**
   * The coordination root is in a state this process refuses to touch: a foreign file, a
   * non-direct child, a symlinked segment, or content whose digest is not the identity the
   * caller proved.
   *
   * `security` kind (D9): this is a containment refusal, not an invariant violation. Fail-
   * closed is correct and the operator action is a real, safe step — inspect the directory
   * — rather than "report a bug". `configuration` exit class because the resolution is an
   * environment fix the operator can make.
   */
  'CORE.RUNTIME_COORDINATION.UNSAFE_STATE': {
    code: 'CORE.RUNTIME_COORDINATION.UNSAFE_STATE',
    source: 'infrastructure',
    defaultResponsibility: 'environment',
    kind: 'security',
    retry: 'never',
    severity: 'error',
    exposure: 'public',
    exitClass: 'configuration',
    operatorAction:
      'Inspect the runtime coordination directory for unexpected or symlinked entries and remove them, then re-run.',
    stability: 'public',
    lifecycle: 'active',
    publicMetadataKeys: ['condition'],
  },

  /**
   * A persisted coordination record is structurally invalid — bad shape, bad version, a
   * duplicate ticket, or bounds violated.
   *
   * `integrity` kind (D9), distinct from `UNSAFE_STATE`: the filesystem is behaving, the
   * *record* is wrong. That distinction is what lets support tell tampering from a hostile
   * mount. Recoverable, and the recovery is the same in every case: remove the record.
   */
  'CORE.RUNTIME_COORDINATION.CORRUPT_RECORD': {
    code: 'CORE.RUNTIME_COORDINATION.CORRUPT_RECORD',
    source: 'infrastructure',
    defaultResponsibility: 'environment',
    kind: 'integrity',
    retry: 'never',
    severity: 'error',
    exposure: 'public',
    exitClass: 'configuration',
    operatorAction:
      'A runtime coordination record is corrupt. Remove the named record and re-run; no project data is affected.',
    stability: 'public',
    lifecycle: 'active',
    publicMetadataKeys: ['condition', 'recordKind'],
  },

  /**
   * A filesystem probe the coordination walk depends on failed for a reason that is not
   * "absent".
   *
   * Before this code every non-`ENOENT` errno became an UNSAFE verdict with neither the
   * path nor the errno attached, and the enclosing retry then reinterpreted it as "changed
   * during inspection" — an `EACCES` was indistinguishable from a missing directory and
   * was retried forever. `errno` is allowlisted because triage is impossible without it.
   */
  'CORE.RUNTIME_COORDINATION.PROBE_FAILED': {
    code: 'CORE.RUNTIME_COORDINATION.PROBE_FAILED',
    source: 'infrastructure',
    defaultResponsibility: 'environment',
    kind: 'I/O',
    retry: 'caller-policy',
    severity: 'error',
    exposure: 'public',
    exitClass: 'runtime',
    operatorAction:
      'A runtime coordination path could not be inspected. Check the reported errno and the permissions on the runtime directory.',
    stability: 'public',
    lifecycle: 'active',
    publicMetadataKeys: ['errno', 'condition'],
  },

  /**
   * A normal, expected precondition blocks this operation — an active maintenance writer,
   * a pending uninstall receipt, or an owner token that changed under an exactness guard.
   *
   * Separated from `UNSAFE_STATE` because raising routine contention as a security verdict
   * forced callers (prune, in particular) to treat an ordinary "someone else is working"
   * state as corruption.
   */
  'CORE.RUNTIME_COORDINATION.CONFLICT': {
    code: 'CORE.RUNTIME_COORDINATION.CONFLICT',
    source: 'application',
    defaultResponsibility: 'environment',
    kind: 'conflict',
    retry: 'transient',
    severity: 'error',
    exposure: 'public',
    exitClass: 'runtime',
    operatorAction:
      'Another opensip operation currently holds this state. Wait for it to finish and re-run.',
    stability: 'public',
    lifecycle: 'active',
    publicMetadataKeys: ['condition'],
  },

  /**
   * Reclaim of an abandoned coordination record was deliberately skipped.
   *
   * `warning` severity: this is reported degradation, not a failed operation — the run
   * continues and the record is reclaimed on a later pass. It carries a code so the skip is
   * observable instead of silent, which is the whole point of ruling D7.
   */
  'CORE.RUNTIME_COORDINATION.RECLAIM_SKIPPED': {
    code: 'CORE.RUNTIME_COORDINATION.RECLAIM_SKIPPED',
    source: 'infrastructure',
    defaultResponsibility: 'environment',
    kind: 'conflict',
    retry: 'transient',
    severity: 'warning',
    exposure: 'public',
    exitClass: 'success',
    operatorAction:
      'An abandoned runtime record was left in place this run and will be reclaimed later. No action required.',
    stability: 'public',
    lifecycle: 'active',
    publicMetadataKeys: ['condition'],
  },

  /**
   * A caller passed an unusable value to the coordination API: an unknown recovery-effect
   * discriminant, a malformed digest, content over the resolved bound, or a bad key.
   *
   * `tool-author` responsibility and `validation` kind — these are programmatic API inputs
   * reachable only from untyped JS callers or a caller bug, never from user configuration.
   * A distinct code lets a caller pre-empt the refusal instead of parsing a message.
   */
  'VALIDATION.RUNTIME_COORDINATION.INPUT': {
    code: 'VALIDATION.RUNTIME_COORDINATION.INPUT',
    source: 'application',
    defaultResponsibility: 'tool-author',
    kind: 'validation',
    retry: 'never',
    severity: 'error',
    exposure: 'public',
    exitClass: 'runtime',
    operatorAction:
      'Correct the named runtime coordination input and retry; this is a caller contract violation, not a project state problem.',
    stability: 'public',
    lifecycle: 'active',
    publicMetadataKeys: ['condition', 'field'],
  },

  /**
   * A compare-and-set failed: the anchored record changed since the caller observed it.
   *
   * Kept under the `SYSTEM.` head because callers already branch on this exact literal
   * (`tryCreate`-style flows depend on telling CAS failure from a hard error). Registering
   * it replaces the `SYSTEM_ERROR` family fallback with `conflict`/`transient`, which is
   * what the branching callers were assuming all along.
   */
  'SYSTEM.RUNTIME_COORDINATION.CAS_MISMATCH': {
    code: 'SYSTEM.RUNTIME_COORDINATION.CAS_MISMATCH',
    source: 'infrastructure',
    defaultResponsibility: 'environment',
    kind: 'conflict',
    retry: 'transient',
    severity: 'error',
    exposure: 'public',
    exitClass: 'runtime',
    operatorAction:
      'The record changed while it was being updated. Re-read the current state and retry the operation.',
    stability: 'public',
    lifecycle: 'active',
    publicMetadataKeys: ['condition'],
  },

  /**
   * The coordination record the caller asked to create already exists.
   *
   * Same reasoning as `CAS_MISMATCH`: an expected, branchable outcome that the `SYSTEM_ERROR`
   * fallback described as an internal invariant.
   */
  'SYSTEM.RUNTIME_COORDINATION.EXISTS': {
    code: 'SYSTEM.RUNTIME_COORDINATION.EXISTS',
    source: 'infrastructure',
    defaultResponsibility: 'environment',
    kind: 'conflict',
    retry: 'never',
    severity: 'error',
    exposure: 'public',
    exitClass: 'runtime',
    operatorAction:
      'The runtime coordination record already exists. Read the existing record instead of creating it.',
    stability: 'public',
    lifecycle: 'active',
    publicMetadataKeys: ['condition'],
  },

  /**
   * A coordination key does not satisfy the key grammar.
   *
   * The ledger records this same condition being thrown three different ways
   * (`UNSAFE`, `INVALID_KEY` in two files); one registered code retires that inconsistency.
   */
  'SYSTEM.RUNTIME_COORDINATION.INVALID_KEY': {
    code: 'SYSTEM.RUNTIME_COORDINATION.INVALID_KEY',
    source: 'application',
    defaultResponsibility: 'tool-author',
    kind: 'validation',
    retry: 'never',
    severity: 'error',
    exposure: 'public',
    exitClass: 'runtime',
    operatorAction: 'Supply a runtime coordination key that matches the documented key grammar.',
    stability: 'public',
    lifecycle: 'active',
    publicMetadataKeys: ['condition'],
  },
} as const satisfies Record<string, Omit<ErrorDefinition, 'owner'>>;
