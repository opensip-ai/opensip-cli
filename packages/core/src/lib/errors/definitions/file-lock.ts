/**
 * File-lock and ephemeral-cache error definitions (Plan 01 Wave 1).
 *
 * Every `CORE.LOCK.*` code below replaces a `SYSTEM.LOCK.*` legacy-grammar literal that had
 * no catalog entry and therefore inherited generic `SYSTEM_ERROR` axes. The lock module's
 * conditions are not one failure: an acquisition timeout is contention, a mode that cannot
 * be restricted to 0600 is a security posture failure, a stalled `writeSync` is resource
 * exhaustion, and a hard-link identity proof that fails is an integrity refusal.
 *
 * The `CORE.EPHEMERAL_CACHE.*` codes replace bare `new Error` throws on the user-cache
 * containment path — the ledger's highest-risk untyped throws in this package, because a
 * hostile-ownership finding normalized to `SYSTEM_ERROR` / `known: 'unknown'` and lost both
 * its `security` kind and its operator action.
 */

import type { ErrorDefinition } from '../../error-definition.js';

export const fileLockDefinitions = {
  /**
   * A second `opensip` run is holding the project datastore lock.
   *
   * The user-visible face of lock contention. It inherited the generic `TIMEOUT` definition,
   * so the operator action was "increase the deadline" — useless when the real answer is
   * "another run owns it". `ownerPid` / `ownerHostname` are already carried on the error and
   * are allowlisted here so the message can name who.
   */
  'CORE.LOCK.ACQUIRE_TIMEOUT': {
    code: 'CORE.LOCK.ACQUIRE_TIMEOUT',
    source: 'infrastructure',
    defaultResponsibility: 'environment',
    kind: 'timeout',
    retry: 'transient',
    severity: 'error',
    exposure: 'public',
    exitClass: 'runtime',
    operatorAction:
      'Another opensip run holds this lock. Wait for it to finish and re-run; if no such run exists, remove the stale lock file named in the message.',
    stability: 'public',
    lifecycle: 'active',
    publicMetadataKeys: ['ownerPid', 'ownerHostname', 'condition'],
  },

  /**
   * A lock policy duration is not usable — non-finite, negative, or beyond the timer bound.
   *
   * `user` responsibility, not `tool-author`: this IS reachable from config-supplied lock
   * policy, which is exactly what the ledger flagged about the old `SystemError` shape.
   */
  'CORE.LOCK.INVALID_POLICY': {
    code: 'CORE.LOCK.INVALID_POLICY',
    source: 'application',
    defaultResponsibility: 'user',
    kind: 'validation',
    retry: 'never',
    severity: 'error',
    exposure: 'public',
    exitClass: 'configuration',
    operatorAction:
      'Set the lock policy duration to a positive number of milliseconds within the supported range, then re-run.',
    stability: 'public',
    lifecycle: 'active',
    publicMetadataKeys: ['condition', 'field'],
  },

  /**
   * The lock file is not a lock file: a symlink, a non-regular file, or a link count outside
   * the expected set.
   *
   * Fail-closed and correct. `security` kind because refusing is a containment decision.
   */
  'CORE.LOCK.MALFORMED': {
    code: 'CORE.LOCK.MALFORMED',
    source: 'infrastructure',
    defaultResponsibility: 'environment',
    kind: 'security',
    retry: 'never',
    severity: 'error',
    exposure: 'public',
    exitClass: 'configuration',
    operatorAction:
      'The lock path is not a regular file. Remove or replace the named path, then re-run.',
    stability: 'public',
    lifecycle: 'active',
    publicMetadataKeys: ['condition'],
  },

  /** A caller asked to store more than the 4 KiB bound allows in a lock record. */
  'CORE.LOCK.METADATA_TOO_LARGE': {
    code: 'CORE.LOCK.METADATA_TOO_LARGE',
    source: 'application',
    defaultResponsibility: 'tool-author',
    kind: 'validation',
    retry: 'never',
    severity: 'error',
    exposure: 'public',
    exitClass: 'runtime',
    operatorAction: 'Reduce the lock record metadata below the documented size bound.',
    stability: 'public',
    lifecycle: 'active',
    publicMetadataKeys: ['condition', 'bound'],
  },

  /** The lock file mode could not be restricted to 0600. */
  'CORE.LOCK.UNSAFE_MODE': {
    code: 'CORE.LOCK.UNSAFE_MODE',
    source: 'infrastructure',
    defaultResponsibility: 'environment',
    kind: 'security',
    retry: 'never',
    severity: 'error',
    exposure: 'public',
    exitClass: 'configuration',
    operatorAction:
      'The lock file could not be restricted to owner-only permissions. Check the umask and the filesystem mount options for the runtime directory.',
    stability: 'public',
    lifecycle: 'active',
    publicMetadataKeys: ['condition'],
  },

  /**
   * Publication of a lock record could not be proven correct — the hard-link identity check
   * failed, the temporary could not be retired, or revalidation saw different bytes.
   *
   * `integrity`: the write protocol's own proof failed, which means the record must not be
   * trusted even though no errno was raised.
   */
  'CORE.LOCK.UNSAFE_PUBLICATION': {
    code: 'CORE.LOCK.UNSAFE_PUBLICATION',
    source: 'infrastructure',
    defaultResponsibility: 'environment',
    kind: 'integrity',
    retry: 'transient',
    severity: 'error',
    exposure: 'public',
    exitClass: 'configuration',
    operatorAction:
      'The lock record could not be published safely. Re-run; if it repeats, the runtime directory may be on a filesystem without reliable hard links.',
    stability: 'public',
    lifecycle: 'active',
    publicMetadataKeys: ['condition'],
  },

  /** The publication temporary could not be proven private and complete. */
  'CORE.LOCK.UNSAFE_TEMP': {
    code: 'CORE.LOCK.UNSAFE_TEMP',
    source: 'infrastructure',
    defaultResponsibility: 'environment',
    kind: 'integrity',
    retry: 'transient',
    severity: 'error',
    exposure: 'public',
    exitClass: 'configuration',
    operatorAction:
      'The lock temporary file could not be verified as private and complete. Re-run; if it repeats, check for another process writing into the runtime directory.',
    stability: 'public',
    lifecycle: 'active',
    publicMetadataKeys: ['condition'],
  },

  /**
   * `writeSync` made no progress.
   *
   * `resource` kind with `caller-policy` retry, as the ledger prescribes: a stalled write is
   * a full disk or an exhausted descriptor table, not a code defect.
   */
  'CORE.LOCK.WRITE_STALLED': {
    code: 'CORE.LOCK.WRITE_STALLED',
    source: 'infrastructure',
    defaultResponsibility: 'environment',
    kind: 'resource',
    retry: 'caller-policy',
    severity: 'error',
    exposure: 'public',
    exitClass: 'runtime',
    operatorAction:
      'A lock write stalled. Check free space and file-descriptor limits for the runtime directory, then retry.',
    stability: 'public',
    lifecycle: 'active',
    publicMetadataKeys: ['condition'],
  },

  /**
   * The ephemeral cache directory changed identity, or escaped its expected parent, between
   * the check and the use.
   *
   * `integrity` kind per D9 — a TOCTOU detection. This is the one condition an operator most
   * needs told apart from a plain I/O fault, because it can mean another process is racing
   * the cache root.
   */
  'CORE.EPHEMERAL_CACHE.IDENTITY_CHANGED': {
    code: 'CORE.EPHEMERAL_CACHE.IDENTITY_CHANGED',
    source: 'infrastructure',
    defaultResponsibility: 'environment',
    kind: 'integrity',
    retry: 'never',
    severity: 'error',
    exposure: 'public',
    exitClass: 'configuration',
    operatorAction:
      'The user cache directory changed identity while it was in use. Remove the named cache directory and re-run.',
    stability: 'public',
    lifecycle: 'active',
    // `hop` names WHICH directory in the fixed hierarchy refused (home/cache/projects/
    // runtime). The absolute path is deliberately never published: it contains the user's
    // home directory, and a public definition that carries $HOME is how a public exposure
    // becomes a leak.
    publicMetadataKeys: ['condition', 'hop'],
  },

  /**
   * The ephemeral cache root fails its ownership, permission, or containment posture check.
   *
   * `security` kind per D9: the refusal is the guard working. Previously a bare `new Error`,
   * so a hostile-ownership finding was reported as an internal invariant with no action.
   */
  'CORE.EPHEMERAL_CACHE.UNSAFE_POSTURE': {
    code: 'CORE.EPHEMERAL_CACHE.UNSAFE_POSTURE',
    source: 'infrastructure',
    defaultResponsibility: 'environment',
    kind: 'security',
    retry: 'never',
    severity: 'error',
    exposure: 'public',
    exitClass: 'configuration',
    operatorAction:
      'The user cache directory is not owned by this user or is world-writable. Fix its ownership and permissions, or remove it so opensip can recreate it.',
    stability: 'public',
    lifecycle: 'active',
    publicMetadataKeys: ['condition', 'hop'],
  },

  /** The ephemeral cache root could not be prepared at all. */
  'CORE.EPHEMERAL_CACHE.PREPARE_FAILED': {
    code: 'CORE.EPHEMERAL_CACHE.PREPARE_FAILED',
    source: 'infrastructure',
    defaultResponsibility: 'environment',
    kind: 'I/O',
    retry: 'caller-policy',
    severity: 'error',
    exposure: 'public',
    exitClass: 'runtime',
    operatorAction:
      'The user cache directory could not be created. Check the reported errno, free space, and permissions on the parent directory.',
    stability: 'public',
    lifecycle: 'active',
    publicMetadataKeys: ['errno', 'condition', 'hop'],
  },
} as const satisfies Record<string, Omit<ErrorDefinition, 'owner'>>;
