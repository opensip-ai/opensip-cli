/**
 * Runtime-lease and recovery error definitions (Plan 01 Wave 1).
 *
 * Two groups live here. The `SYSTEM.RUNTIME_LEASE.*` codes are **caller-contract**
 * violations — a tool asked the lease API for something the protocol forbids — and keep
 * their existing code literals because callers already branch on them; registering them
 * only replaces the `SYSTEM_ERROR` family fallback with honest axes. The `CORE.*` codes are
 * conditions the ledger judged to be misclassified: capacity exhaustion reported as an
 * invariant, and interrupted-journal recovery reported as a configuration error whose
 * operator action pointed at `opensip-cli.config.yml` instead of at recovery.
 */

import type { ErrorDefinition } from '../../error-definition.js';

/**
 * The `SYSTEM.RUNTIME_LEASE.*` cluster: a caller asked the lease protocol for something it
 * forbids. One (responsibility x exposure x exit) shape per D9 — the condition varies, the
 * audience and the fix do not. `public` because the caller is a tool author who must read it.
 */
const LEASE_CALLER_CONTRACT = {
  source: 'application',
  defaultResponsibility: 'tool-author',
  retry: 'never',
  severity: 'error',
  exposure: 'public',
  exitClass: 'runtime',
  stability: 'public',
  lifecycle: 'active',
} as const satisfies Omit<ErrorDefinition, 'owner' | 'code' | 'kind' | 'operatorAction'>;

export const runtimeLeaseDefinitions = {
  /**
   * A bounded runtime registry is full: references per owner, project keys, the writer
   * queue, or the deferred-cleanup table.
   *
   * `resource` kind and `caller-policy` retry (was `invariant`/`never`): these bounds are
   * reached by legitimate nesting and by contention, so the caller needs a policy handle
   * rather than a bug report. The anti-DoS bounds are doing their job when this fires.
   */
  'CORE.RUNTIME_LEASE.CAPACITY': {
    code: 'CORE.RUNTIME_LEASE.CAPACITY',
    source: 'infrastructure',
    defaultResponsibility: 'environment',
    kind: 'resource',
    retry: 'caller-policy',
    severity: 'error',
    exposure: 'public',
    exitClass: 'runtime',
    operatorAction:
      'A runtime coordination bound is exhausted. Reduce concurrent opensip runs or nesting depth, then retry.',
    stability: 'public',
    lifecycle: 'active',
    publicMetadataKeys: ['condition', 'bound'],
  },

  /**
   * A child run may not inherit the parent's lease.
   *
   * This is the fairness invariant of the whole inheritance feature — inheritance must not
   * jump a writer that queued before the parent, and the composite parent dimension must be
   * complete. Refusing is correct; the code makes the refusal branchable.
   */
  'CORE.RUNTIME_LEASE.INHERITANCE_DENIED': {
    code: 'CORE.RUNTIME_LEASE.INHERITANCE_DENIED',
    source: 'application',
    defaultResponsibility: 'environment',
    kind: 'conflict',
    retry: 'transient',
    severity: 'error',
    exposure: 'public',
    exitClass: 'runtime',
    operatorAction:
      'This run cannot inherit the parent runtime lease. Let the queued writer finish, then re-run.',
    stability: 'public',
    lifecycle: 'active',
    publicMetadataKeys: ['condition', 'dimension'],
  },

  /**
   * An interrupted `init` / `uninstall` journal blocks this operation until recovery runs.
   *
   * Previously a `ConfigurationError`, whose operator action reads "Check
   * opensip-cli.config.yml and CLI flags" — wrong, and actively misleading, for a state
   * whose only forward path is the recovery command. This is the module's most user-visible
   * refusal, so the action names the real next step.
   */
  'CORE.RUNTIME_RECOVERY.REQUIRED': {
    code: 'CORE.RUNTIME_RECOVERY.REQUIRED',
    source: 'application',
    defaultResponsibility: 'user',
    kind: 'conflict',
    retry: 'never',
    severity: 'error',
    exposure: 'public',
    exitClass: 'configuration',
    operatorAction:
      'A previous opensip init or uninstall was interrupted. Run `opensip init` to complete recovery before retrying.',
    stability: 'public',
    lifecycle: 'active',
    publicMetadataKeys: ['condition', 'journal'],
  },

  /**
   * The recovery header could not be inspected, so recovery state is unknown.
   *
   * `inspectRecoveryHeader` collapsed every failure — a `settleCoordinationLinkedCreate`
   * throw, a sibling-scan throw, any non-`ENOENT` errno, any read failure — into
   * `{ status: 'malformed', reason: 'unsafe-file' }`. A transient `EMFILE` was therefore
   * indistinguishable from a genuinely corrupt header, and the caller destroyed state on
   * both. `errno` is allowlisted so those two can be told apart.
   */
  'CORE.RUNTIME_RECOVERY.PROBE_FAILED': {
    code: 'CORE.RUNTIME_RECOVERY.PROBE_FAILED',
    source: 'infrastructure',
    defaultResponsibility: 'environment',
    kind: 'I/O',
    retry: 'caller-policy',
    severity: 'error',
    exposure: 'public',
    exitClass: 'runtime',
    operatorAction:
      'The recovery header could not be read. Check the reported errno and the permissions on the runtime directory before retrying.',
    stability: 'public',
    lifecycle: 'active',
    publicMetadataKeys: ['errno', 'condition'],
  },

  /**
   * A lease handle was used outside the authority it was granted — a destructive-journal
   * authority attempting a read, or a receipt-only authority touching anything but the
   * fixed receipt.
   *
   * Least-authority refusals: the inherited `tool-author` / `invariant` / `runtime` axes are
   * correct here, so registration only removes the family fallback.
   */
  'SYSTEM.RUNTIME_LEASE.AUTHORITY_SCOPE': {
    ...LEASE_CALLER_CONTRACT,
    code: 'SYSTEM.RUNTIME_LEASE.AUTHORITY_SCOPE',
    kind: 'permission',
    operatorAction:
      'This lease handle does not carry authority for the requested operation. Acquire the correct authority instead of widening this one.',
    publicMetadataKeys: ['condition'],
  },

  /** A shared lease cannot be upgraded to exclusive, and exclusive leases cannot nest. */
  'SYSTEM.RUNTIME_LEASE.EXCLUSIVE_UPGRADE': {
    ...LEASE_CALLER_CONTRACT,
    code: 'SYSTEM.RUNTIME_LEASE.EXCLUSIVE_UPGRADE',
    kind: 'invariant',
    operatorAction:
      'Acquire an exclusive runtime lease up front; a shared lease cannot be upgraded in place.',
    publicMetadataKeys: ['condition'],
  },

  /** Two writer requests were enqueued for one owner token. */
  'SYSTEM.RUNTIME_LEASE.DUPLICATE_WRITER': {
    ...LEASE_CALLER_CONTRACT,
    code: 'SYSTEM.RUNTIME_LEASE.DUPLICATE_WRITER',
    kind: 'invariant',
    operatorAction: 'Enqueue at most one runtime writer request per owner token.',
    publicMetadataKeys: ['condition'],
  },

  /** A shared acquisition named no dimensions, which cannot mean anything. */
  'SYSTEM.RUNTIME_LEASE.EMPTY_ACCESS': {
    ...LEASE_CALLER_CONTRACT,
    code: 'SYSTEM.RUNTIME_LEASE.EMPTY_ACCESS',
    kind: 'validation',
    operatorAction: 'Name at least one shared dimension when acquiring a runtime access lease.',
    publicMetadataKeys: ['condition'],
  },

  /** The supplied owner token does not satisfy the owner-token grammar. */
  'SYSTEM.RUNTIME_LEASE.INVALID_OWNER': {
    ...LEASE_CALLER_CONTRACT,
    code: 'SYSTEM.RUNTIME_LEASE.INVALID_OWNER',
    kind: 'validation',
    operatorAction: 'Supply a runtime lease owner token that matches the documented grammar.',
    publicMetadataKeys: ['condition'],
  },

  /**
   * A lease record belongs to a different process or a different project.
   *
   * The exactness guard that keeps one project's runs from releasing another's lease.
   */
  'SYSTEM.RUNTIME_LEASE.OWNER_MISMATCH': {
    ...LEASE_CALLER_CONTRACT,
    code: 'SYSTEM.RUNTIME_LEASE.OWNER_MISMATCH',
    kind: 'conflict',
    operatorAction:
      'This runtime lease belongs to another process or project and cannot be modified from here.',
    publicMetadataKeys: ['condition'],
  },

  /**
   * The writer's own queue entry vanished mid-acquisition.
   *
   * `integrity`, not `invariant`: the caller did nothing wrong — persisted state was
   * removed underneath it, which means another actor or a manual cleanup intervened.
   */
  'SYSTEM.RUNTIME_LEASE.REQUEST_LOST': {
    code: 'SYSTEM.RUNTIME_LEASE.REQUEST_LOST',
    source: 'infrastructure',
    defaultResponsibility: 'environment',
    kind: 'integrity',
    retry: 'transient',
    severity: 'error',
    exposure: 'public',
    exitClass: 'runtime',
    operatorAction:
      'The runtime writer request disappeared during acquisition. Re-run; if it repeats, check whether the runtime directory is being cleaned externally.',
    stability: 'public',
    lifecycle: 'active',
    publicMetadataKeys: ['condition'],
  },
} as const satisfies Record<string, Omit<ErrorDefinition, 'owner'>>;
