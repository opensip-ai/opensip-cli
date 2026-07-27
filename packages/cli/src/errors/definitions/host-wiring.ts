/**
 * Host wiring and dispatch failures — the CLI failing to assemble or run itself.
 *
 * One of the host catalog's definition modules. They are separate files because the catalog
 * outgrew the file-length bound as a single unit, not because the groups are independent —
 * `host-error-catalog.ts` assembles them into one catalog with one owner and one head.
 */

import { HOST_WIRING, USER_INPUT } from './axes.js';

export const hostWiringDefinitions = {
  /**
   * The command needs an initialized project and there is not one here.
   *
   * The most common host-side user failure after a missing config file, and the operator
   * action is the whole value of the code: run from inside a project, or pass `--cwd`.
   */
  'CLI.HOST.PROJECT_REQUIRED': {
    ...USER_INPUT,
    code: 'CLI.HOST.PROJECT_REQUIRED',
    kind: 'not-found',
    operatorAction:
      'Run from within an initialized project directory, or pass --cwd pointing at one. `opensip init` creates one.',
    publicMetadataKeys: ['condition'],
  },

  /**
   * A value supplied on the command line or in host configuration cannot be used: an invalid
   * startup option, a lock-policy override out of range, an artifact target that is a
   * directory, a malformed target set, a bad tool id for data purge, a catalog budget that is
   * not a number.
   */
  'CLI.HOST.OPTION_INVALID': {
    ...USER_INPUT,
    code: 'CLI.HOST.OPTION_INVALID',
    operatorAction:
      'Correct the named option or configuration value and re-run; the message names the field and what was expected.',
    publicMetadataKeys: ['condition', 'field', 'value'],
  },

  /**
   * The startup runtime lease is required and absent, or was already consumed.
   *
   * `conflict`, not `validation`: nothing the user typed is wrong. Either another run holds
   * the lease or this process already spent it, and both are resolved by re-running.
   */
  'CLI.HOST.STARTUP_LEASE': {
    ...USER_INPUT,
    code: 'CLI.HOST.STARTUP_LEASE',
    kind: 'conflict',
    retry: 'transient',
    operatorAction:
      'The startup runtime lease was unavailable. Wait for other opensip runs to finish and re-run.',
    publicMetadataKeys: ['condition'],
  },

  /**
   * A tool claimed a host-reserved identity or contributed outside its allowed namespace.
   *
   * `security` kind — the namespace boundary is what stops one tool impersonating the host
   * or another tool.
   */
  'CLI.HOST_IDENTITY.RESERVED': {
    code: 'CLI.HOST_IDENTITY.RESERVED',
    source: 'application',
    defaultResponsibility: 'tool-author',
    kind: 'security',
    retry: 'never',
    severity: 'error',
    exposure: 'public',
    exitClass: 'plugin-incompatible',
    operatorAction:
      'Rename the contribution into a namespace the tool owns; host-reserved identities are refused.',
    stability: 'public',
    lifecycle: 'active',
    publicMetadataKeys: ['condition', 'value'],
  },

  /**
   * A host code path ran in a state the composition root should have made impossible: no
   * project on the scope, a datastore resolved outside the project, a re-entrant command
   * scope, a command whose runtime scope was never declared, a missing external-tool
   * identity, a command result that came back undefined.
   */
  'CLI.HOST.WIRING_INVALID': {
    ...HOST_WIRING,
    code: 'CLI.HOST.WIRING_INVALID',
    operatorAction: 'Capture the run id and report a bug; the CLI host was misdriven.',
    publicMetadataKeys: ['condition'],
  },

  /**
   * Dispatching a command to a tool or worker failed.
   *
   * `environment` rather than `tool-author`: the common causes are a missing package
   * directory, an unreachable handler and a worker that died — conditions about the install,
   * not about the code. `caller-policy` retry because a worker fault is often transient.
   */
  'CLI.HOST.DISPATCH_FAILED': {
    ...HOST_WIRING,
    code: 'CLI.HOST.DISPATCH_FAILED',
    defaultResponsibility: 'environment',
    kind: 'I/O',
    retry: 'caller-policy',
    exposure: 'public',
    operatorAction:
      'The command could not be dispatched. Reinstall the tool package and retry; if it persists, capture the run id and report a bug.',
    publicMetadataKeys: ['condition', 'tool', 'packageName', 'domainId', 'failureClass'],
  },

  /**
   * An artifact directory or file could not be written.
   *
   * `warning` / `success` per ruling D7: the analysis already ran and its verdict is
   * credible. Failing the command because a report file could not be written would destroy
   * a result the user paid for.
   */
  'CLI.HOST.ARTIFACT_WRITE_FAILED': {
    ...HOST_WIRING,
    code: 'CLI.HOST.ARTIFACT_WRITE_FAILED',
    defaultResponsibility: 'environment',
    kind: 'I/O',
    retry: 'caller-policy',
    severity: 'warning',
    exposure: 'public',
    exitClass: 'success',
    operatorAction:
      'The artifact could not be written; the run itself succeeded. Check permissions and free space for the output path.',
    publicMetadataKeys: ['errno', 'condition'],
  },

  /**
   * A bounded host probe hit its safety limit, or could not open what it needed.
   *
   * `resource`: the bound is an anti-DoS work limit on a path that runs before a scope
   * exists, so it must fail closed rather than grow.
   */
  'CLI.HOST.PROBE_LIMIT': {
    ...HOST_WIRING,
    code: 'CLI.HOST.PROBE_LIMIT',
    defaultResponsibility: 'environment',
    kind: 'resource',
    operatorAction:
      'A host startup probe exceeded its safety bound. Capture the run id and report a bug.',
    publicMetadataKeys: ['condition'],
  },

  /**
   * A capability pack declared an isolation domain the owning tool has no bridge for.
   *
   * Raised INSIDE the worker and marshalled to the parent, so it needs machine identity to
   * survive the wire: as a bare `Error` it reached the supervisor as an untyped message and
   * the parent could not tell a wiring fault from the pack's own failure.
   *
   * `compatibility` and `tool-author`: the pack and the tool disagree about what exists.
   * Nothing an operator configures changes it.
   */
  'CLI.CAPABILITY_WORKER.NO_ISOLATION_BRIDGE': {
    ...HOST_WIRING,
    code: 'CLI.CAPABILITY_WORKER.NO_ISOLATION_BRIDGE',
    kind: 'compatibility',
    exposure: 'public',
    operatorAction:
      'The capability pack targets an isolation domain its owning tool does not provide. Report it to the pack author with the domain id.',
    publicMetadataKeys: ['domainId', 'ownerToolId'],
  },

  /**
   * The advisory in-worker guard blocked a resource the pack's manifest did not declare.
   *
   * Thrown from monkey-patched `fs`/`net`/`child_process`/`fetch` into arbitrary pack and
   * dependency code, which may catch it and carry on — so it MUST carry machine identity.
   * As a bare `Error` there was no way, from the outside, to tell a swallowed denial from
   * normal operation.
   *
   * `security` and advisory both: admission is the enforced boundary (ADR-0128), this guard
   * is defence in depth, and the message says so.
   */
  'CLI.CAPABILITY_WORKER.RESOURCE_DENIED': {
    ...HOST_WIRING,
    code: 'CLI.CAPABILITY_WORKER.RESOURCE_DENIED',
    defaultResponsibility: 'tool-author',
    kind: 'security',
    exposure: 'public',
    operatorAction:
      'The capability pack reached for a resource it did not declare. Add it to the pack manifest, or report it to the pack author.',
    publicMetadataKeys: ['resource'],
  },
} as const;
