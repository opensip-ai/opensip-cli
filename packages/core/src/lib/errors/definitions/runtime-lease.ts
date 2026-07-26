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

/**
 * Shared axes for every lease/coordination wait timeout.
 *
 * `environment` + `transient`: a lease timeout is never the caller's mistake and is almost
 * always resolved by waiting, which is the opposite of what the generic `TIMEOUT` definition's
 * "increase the deadline or reduce workload" told operators to do.
 */
const LEASE_TIMEOUT = {
  source: 'infrastructure',
  defaultResponsibility: 'environment',
  kind: 'timeout',
  retry: 'transient',
  severity: 'error',
  exposure: 'public',
  exitClass: 'runtime',
  stability: 'public',
  lifecycle: 'active',
  publicMetadataKeys: ['waitMs'],
} as const satisfies Omit<ErrorDefinition, 'owner' | 'code' | 'operatorAction'>;

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
  'CORE.RUNTIME_LEASE.AUTHORITY_SCOPE': {
    ...LEASE_CALLER_CONTRACT,
    code: 'CORE.RUNTIME_LEASE.AUTHORITY_SCOPE',
    kind: 'permission',
    operatorAction:
      'This lease handle does not carry authority for the requested operation. Acquire the correct authority instead of widening this one.',
    publicMetadataKeys: ['condition'],
  },

  /** A shared lease cannot be upgraded to exclusive, and exclusive leases cannot nest. */
  'CORE.RUNTIME_LEASE.EXCLUSIVE_UPGRADE': {
    ...LEASE_CALLER_CONTRACT,
    code: 'CORE.RUNTIME_LEASE.EXCLUSIVE_UPGRADE',
    kind: 'invariant',
    operatorAction:
      'Acquire an exclusive runtime lease up front; a shared lease cannot be upgraded in place.',
    publicMetadataKeys: ['condition'],
  },

  /** Two writer requests were enqueued for one owner token. */
  'CORE.RUNTIME_LEASE.DUPLICATE_WRITER': {
    ...LEASE_CALLER_CONTRACT,
    code: 'CORE.RUNTIME_LEASE.DUPLICATE_WRITER',
    kind: 'invariant',
    operatorAction: 'Enqueue at most one runtime writer request per owner token.',
    publicMetadataKeys: ['condition'],
  },

  /** A shared acquisition named no dimensions, which cannot mean anything. */
  'CORE.RUNTIME_LEASE.EMPTY_ACCESS': {
    ...LEASE_CALLER_CONTRACT,
    code: 'CORE.RUNTIME_LEASE.EMPTY_ACCESS',
    kind: 'validation',
    operatorAction: 'Name at least one shared dimension when acquiring a runtime access lease.',
    publicMetadataKeys: ['condition'],
  },

  /** The supplied owner token does not satisfy the owner-token grammar. */
  'CORE.RUNTIME_LEASE.INVALID_OWNER': {
    ...LEASE_CALLER_CONTRACT,
    code: 'CORE.RUNTIME_LEASE.INVALID_OWNER',
    kind: 'validation',
    operatorAction: 'Supply a runtime lease owner token that matches the documented grammar.',
    publicMetadataKeys: ['condition'],
  },

  /**
   * A lease record belongs to a different process or a different project.
   *
   * The exactness guard that keeps one project's runs from releasing another's lease.
   */
  'CORE.RUNTIME_LEASE.OWNER_MISMATCH': {
    ...LEASE_CALLER_CONTRACT,
    code: 'CORE.RUNTIME_LEASE.OWNER_MISMATCH',
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
  'CORE.RUNTIME_LEASE.REQUEST_LOST': {
    code: 'CORE.RUNTIME_LEASE.REQUEST_LOST',
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
  /**
   * A recovery mutation discovered it no longer holds exclusive authority.
   *
   * `integrity`: the caller did nothing wrong and the input is fine — the lease it was
   * operating under was taken or expired mid-mutation, so anything it writes now would be
   * unsound. Refusing is the only safe outcome.
   */
  'CORE.RUNTIME_LEASE.AUTHORITY_LOST': {
    ...LEASE_CALLER_CONTRACT,
    code: 'CORE.RUNTIME_LEASE.AUTHORITY_LOST',
    defaultResponsibility: 'environment',
    kind: 'integrity',
    retry: 'transient',
    operatorAction:
      'The exclusive lease was lost while recovery was running. Re-run; the operation made no partial change.',
    publicMetadataKeys: ['condition'],
  },

  /**
   * Lease acquisition was cancelled.
   *
   * Distinct from every other lease failure: nothing is wrong. `cancelled` kind and exit class
   * so an interrupted acquisition reports as the interruption it was, not as a lease fault
   * (ruling D5 — cancellation carries one meaning).
   */
  'CORE.RUNTIME_LEASE.CANCELLED': {
    ...LEASE_CALLER_CONTRACT,
    code: 'CORE.RUNTIME_LEASE.CANCELLED',
    defaultResponsibility: 'user',
    kind: 'cancelled',
    exitClass: 'cancelled',
    operatorAction: 'Lease acquisition was cancelled. Re-run if the work is still needed.',
  },

  /**
   * A lease policy value is unusable.
   *
   * `user` responsibility: lease policy is reachable from project configuration, so this is an
   * edit the user makes — not a bug report.
   */
  'CORE.RUNTIME_LEASE.INVALID_POLICY': {
    ...LEASE_CALLER_CONTRACT,
    code: 'CORE.RUNTIME_LEASE.INVALID_POLICY',
    defaultResponsibility: 'user',
    kind: 'validation',
    exitClass: 'configuration',
    operatorAction:
      'Set the named runtime lease policy value to a positive number of milliseconds within the supported range.',
    publicMetadataKeys: ['field'],
  },

  /**
   * Waiting for the coordination mutex exceeded its budget.
   *
   * RENAMED from `TIMEOUT.RUNTIME_COORDINATION_MUTEX`, which is two segments and therefore
   * unrepresentable under `CODE_GRAMMAR` — it could never have been registered, which is
   * exactly why it was still riding the family fallback. Two call sites branch on it to map a
   * mutex wait onto a friendlier per-operation timeout, and both move with it.
   */
  'CORE.RUNTIME_COORDINATION.MUTEX': {
    ...LEASE_TIMEOUT,
    code: 'CORE.RUNTIME_COORDINATION.MUTEX',
    operatorAction:
      'Another opensip run holds the coordination mutex. Wait for it to finish and re-run; stop long-lived processes such as `opensip mcp` if it persists.',
  },

  /**
   * One registered timeout per lease wait kind.
   *
   * These were minted dynamically as `TIMEOUT.${kind.toUpperCase()}` — two-segment codes that
   * the grammar rejects, so none of them could ever be registered and every one inherited the
   * generic `TIMEOUT` axes ("increase the deadline"), which is the wrong advice: the real
   * cause is always another run holding the lease.
   *
   * They stay DISTINCT rather than collapsing into one code with the kind in metadata (the
   * usual D9 move) because consumers genuinely branch on which lease timed out — `init` treats
   * an exclusive-lease timeout as retryable promotion contention, while a read timeout is a
   * degraded status read. Metadata is not branchable without parsing.
   */
  'CORE.RUNTIME_LEASE.READ': {
    ...LEASE_TIMEOUT,
    code: 'CORE.RUNTIME_LEASE.READ',
    operatorAction:
      'Timed out waiting to read runtime state. Another opensip run is holding it; wait and re-run.',
  },
  'CORE.RUNTIME_LEASE.EXCLUSIVE': {
    ...LEASE_TIMEOUT,
    code: 'CORE.RUNTIME_LEASE.EXCLUSIVE',
    operatorAction:
      'Timed out waiting for the exclusive runtime lease. Stop or reconnect long-lived OpenSIP processes (including `opensip mcp`) and retry.',
  },
  'CORE.RUNTIME_LEASE.ACCESS_COMPOSITE': {
    ...LEASE_TIMEOUT,
    code: 'CORE.RUNTIME_LEASE.ACCESS_COMPOSITE',
    operatorAction:
      'Timed out assembling the composite runtime access lease. Wait for concurrent runs to finish and retry.',
  },
  'CORE.RUNTIME_LEASE.USER_STATE_READ': {
    ...LEASE_TIMEOUT,
    code: 'CORE.RUNTIME_LEASE.USER_STATE_READ',
    operatorAction:
      'Timed out reading user-state runtime data. Another opensip run is holding it; wait and re-run.',
  },
  'CORE.RUNTIME_LEASE.GLOBAL_MAINTENANCE': {
    ...LEASE_TIMEOUT,
    code: 'CORE.RUNTIME_LEASE.GLOBAL_MAINTENANCE',
    operatorAction:
      'Timed out waiting for global runtime maintenance. Stop or reconnect long-lived OpenSIP processes (including `opensip mcp`) and retry.',
  },
  /**
   * Releasing a runtime lease failed for a reason the release path could not classify.
   *
   * `integrity` and `transient`: the lease may or may not still be held, so the safe reading is
   * that runtime state is uncertain rather than that the caller did something wrong. The
   * original failure is preserved on `cause`.
   */
  'CORE.RUNTIME_LEASE.RELEASE_FAILED': {
    ...LEASE_CALLER_CONTRACT,
    code: 'CORE.RUNTIME_LEASE.RELEASE_FAILED',
    defaultResponsibility: 'environment',
    kind: 'integrity',
    retry: 'transient',
    operatorAction:
      'A runtime lease could not be released cleanly. Re-run; if it repeats, run `opensip status` to inspect runtime state.',
    publicMetadataKeys: ['condition'],
  },
} as const satisfies Record<string, Omit<ErrorDefinition, 'owner'>>;
