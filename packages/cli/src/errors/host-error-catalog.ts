/**
 * `opensip-cli` host error definitions (Plan 01 clean break).
 *
 * WHY THE HOST NEEDS ITS OWN CATALOG
 * The CLI raised 77 code literals with no catalog entry anywhere. They survived only because
 * `legacyFamilyCode` guessed axes from the first token of the code — `CONFIG.*` meant
 * "configuration error", `SYSTEM.*` meant "internal invariant" — and everything it did not
 * recognise became `UNKNOWN_FAILURE`. Deleting that guessing is the point of the clean break,
 * so every one of these had to become a real definition first.
 *
 * WHY 77 LITERALS BECOME 15 DEFINITIONS
 * Ruling D9: a definition is a (responsibility x kind) cluster, not a sentence. Eleven ways of
 * saying "this suite step names something that does not exist" have one audience, one exit
 * class and one fix — the distinguishing detail belongs in allowlisted `metadata.condition`,
 * where it is bounded and projectable, rather than in 11 codes an agent has to enumerate.
 *
 * Codes stay DISTINCT wherever a consumer actually branches on them. That is a real constraint
 * here: `init` treats an exclusive-lease timeout as retryable contention while a read timeout
 * is a degraded status read, and metadata is not branchable without parsing.
 *
 * OWNER
 * Keyed on the npm package name per ruling D1, like every other substrate catalog. The host is
 * not a Tool and has no tool UUID.
 */

import { defineErrorCatalog } from '@opensip-cli/core';

import type { ErrorDefinition } from '@opensip-cli/core';

/** Substrate catalogs are keyed on the npm package name (ruling D1). */
export const HOST_ERROR_OWNER_ID = 'opensip-cli';

/**
 * The user wrote something the host cannot use — in `opensip-cli.config.yml` or on the command
 * line. Public, because the message names the offending value and the fix is an edit.
 */
const USER_INPUT = {
  source: 'application',
  defaultResponsibility: 'user',
  kind: 'validation',
  retry: 'never',
  severity: 'error',
  exposure: 'public',
  exitClass: 'configuration',
  stability: 'public',
  lifecycle: 'active',
} as const satisfies Omit<ErrorDefinition, 'owner' | 'code' | 'operatorAction'>;

/**
 * The host failed to wire itself. Nobody outside this repository can act on these, so they are
 * `redacted` and say "report a bug" honestly rather than inventing a step the operator does
 * not have.
 */
const HOST_WIRING = {
  source: 'application',
  defaultResponsibility: 'tool-author',
  kind: 'invariant',
  retry: 'never',
  severity: 'error',
  exposure: 'redacted',
  exitClass: 'runtime',
  stability: 'public',
  lifecycle: 'active',
} as const satisfies Omit<ErrorDefinition, 'owner' | 'code' | 'operatorAction'>;

export const hostErrorCatalog = defineErrorCatalog(
  {
    id: HOST_ERROR_OWNER_ID,
    displayName: 'OpenSIP CLI host',
    packageName: HOST_ERROR_OWNER_ID,
  },
  {
    // --- Suite authoring (29 literals) ---------------------------------------------------

    /**
     * A suite step is not usable: a bad option value, a missing required option, an
     * unsupported selector or evidence mode, a reserved `cwd`, or an argument the command
     * does not accept.
     *
     * `metadata.condition` carries which of those it was — the detail an agent branches on
     * without needing 12 separate codes to enumerate.
     */
    'CLI.SUITE.INVALID': {
      ...USER_INPUT,
      code: 'CLI.SUITE.INVALID',
      operatorAction:
        'Correct the named suite step in opensip-cli.config.yml; the message names the offending field and value.',
      publicMetadataKeys: ['condition', 'field', 'value'],
    },

    /**
     * A suite step names a tool, command or capability that does not exist — or names one
     * ambiguously.
     *
     * Separated from `INVALID` because the KIND differs and that changes the advice: the fix
     * is to look up what is actually available (`opensip tools list`), not to correct a value.
     */
    'CLI.SUITE.UNKNOWN_REFERENCE': {
      ...USER_INPUT,
      code: 'CLI.SUITE.UNKNOWN_REFERENCE',
      kind: 'not-found',
      operatorAction:
        'The suite step names something that does not exist or is ambiguous. Run `opensip tools list` and use an exact tool and command name.',
      publicMetadataKeys: ['condition', 'value'],
    },

    /**
     * `suite add` refuses to edit `opensip-cli.config.yml` because the file is not in a shape
     * it can safely modify — not a YAML map, malformed, over the editable size bound, or with
     * a `suites` block it cannot merge into without losing content.
     *
     * `integrity` kind: refusing is protecting the user's file. Editing a document we cannot
     * fully parse would silently drop the parts we did not understand.
     */
    'CLI.SUITE.EDIT_REFUSED': {
      ...USER_INPUT,
      code: 'CLI.SUITE.EDIT_REFUSED',
      kind: 'integrity',
      operatorAction:
        'opensip cannot safely edit this config file. Fix the reported problem in opensip-cli.config.yml, or add the suite block by hand.',
      publicMetadataKeys: ['condition', 'path'],
    },

    // --- Host configuration and startup (16 literals) -------------------------------------

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
     * The baseline gate cannot run: no captured baseline, an unstamped signal, or baseline
     * identity that is missing or does not match the current strategy.
     *
     * `tool-author` for the stamping cases and `user` for the missing-baseline case is a real
     * split, but the ACTION is the same in both — capture a baseline, or fix the tool that
     * emitted un-stamped signals — so `metadata.condition` carries which, and the message says
     * who. `exitClass: 'configuration'` preserves the gate's existing exit 2.
     */
    'CLI.GATE.BASELINE_INVALID': {
      ...USER_INPUT,
      code: 'CLI.GATE.BASELINE_INVALID',
      operatorAction:
        'Run the tool with --gate-save to capture a baseline before comparing; if the message reports unstamped signals, report it to the tool author.',
      publicMetadataKeys: ['condition', 'tool'],
    },

    /**
     * Policy refused the operation.
     *
     * Kept distinct from every other configuration failure: a governance denial is not a
     * mistake to correct, and `permission` kind is what tells an agent not to retry or
     * work around it.
     */
    'CLI.POLICY.DENIED': {
      ...USER_INPUT,
      code: 'CLI.POLICY.DENIED',
      defaultResponsibility: 'operator',
      kind: 'permission',
      operatorAction:
        'Policy denied this operation. Change the policy deliberately, or run an operation the policy allows.',
      publicMetadataKeys: ['condition', 'tool'],
    },

    /**
     * Runtime evidence cannot be promoted safely.
     *
     * `security`: the promotion preflight found the manifest untrustworthy, and proceeding
     * would publish evidence we cannot vouch for.
     */
    'CLI.RUNTIME_PROMOTION.MANIFEST_UNSAFE': {
      ...USER_INPUT,
      code: 'CLI.RUNTIME_PROMOTION.MANIFEST_UNSAFE',
      defaultResponsibility: 'environment',
      kind: 'security',
      operatorAction:
        'Runtime evidence could not be promoted safely. Remove the runtime directory named in the message and re-run `opensip init`.',
      publicMetadataKeys: ['reason'],
    },

    // --- Plugin admission (2 literals) -----------------------------------------------------

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

    // --- Host wiring invariants (18 literals) ----------------------------------------------

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
      publicMetadataKeys: ['condition', 'tool'],
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
     * A run-history read argument is unusable: a bad run id, or a limit/offset that is not a
     * non-negative integer.
     *
     * `tool-author` and `runtime`, not `user` and `configuration`: these arrive from a
     * programmatic caller (MCP, an agent) rather than being typed into a config file, so the
     * fix is in the caller's request.
     */
    'CLI.RUN_READ.INPUT_INVALID': {
      ...HOST_WIRING,
      code: 'CLI.RUN_READ.INPUT_INVALID',
      kind: 'validation',
      exposure: 'public',
      operatorAction:
        'Correct the named run-read argument: run ids are 1-128 word characters, and limits and offsets are non-negative integers.',
      publicMetadataKeys: ['field', 'condition'],
    },

    /**
     * A `report` run selector names something the store does not have: an unknown run, or a run
     * with no change-impact data to render.
     *
     * `user` / `not-found`: the user typed or pasted a run id, and the fix is to pick one that
     * exists. The retired `CONFIGURATION.REPORT.*` literals resolved to nothing, so what is
     * plainly a "no such run" answer arrived as an internal fatal.
     */
    'CLI.REPORT.RUN_UNAVAILABLE': {
      ...USER_INPUT,
      code: 'CLI.REPORT.RUN_UNAVAILABLE',
      kind: 'not-found',
      operatorAction:
        'Pick a run that exists — `opensip runs list` shows them — and one that recorded the data this report needs.',
      publicMetadataKeys: ['condition', 'runId'],
    },

    /** A run-history read names a run the store does not have. */
    'CLI.RUNS.NOT_FOUND': {
      ...USER_INPUT,
      code: 'CLI.RUNS.NOT_FOUND',
      kind: 'not-found',
      operatorAction: 'Pick a run id that exists; `opensip runs list` shows the recorded runs.',
      publicMetadataKeys: ['runId'],
    },

    /**
     * An evidence snapshot a tool contributed is not a usable shape.
     *
     * `tool-author` and `runtime`: the snapshot comes from a tool's `collectReportData`, not
     * from anything the user wrote.
     */
    'CLI.RUN_EVIDENCE.INVALID': {
      ...HOST_WIRING,
      code: 'CLI.RUN_EVIDENCE.INVALID',
      kind: 'validation',
      exposure: 'public',
      operatorAction:
        'The tool contributed an evidence snapshot the host cannot store. Report it to the tool author with the run id.',
      publicMetadataKeys: ['field'],
    },
  },
);
