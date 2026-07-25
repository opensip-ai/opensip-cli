/**
 * Configuration, baseline, execution and subprocess error definitions (Plan 01 Wave 1).
 *
 * `CONFIGURATION.CONFIG.NOT_FOUND` is the highest-impact entry in the file and the reason
 * ruling D11 exists. The site throws `ValidationError(…, { code: 'ERRORS.CONFIG.NOT_FOUND' })`
 * — head `ERRORS`, which `legacyFamilyCode` does not map — so the **most common first-run
 * failure in the product** demoted to `CORE.SYSTEM.UNKNOWN_FAILURE`: severity `fatal`,
 * exposure `operator-only`, responsibility `unknown`. Because the exposure is operator-only,
 * `outwardMessage` replaced the enumerated list of checked paths with the literal string
 * "An unexpected internal failure occurred." — the user was told nothing at all.
 *
 * D11 forbids adding `ERRORS` to the family switch; the fix is to rename the code into a
 * catalog that owns it, which is what this file does.
 */

import type { ErrorDefinition } from '../../error-definition.js';

/** Shared axes for "the user's own input or configuration is wrong, and they can fix it". */
const USER_CONFIGURATION = {
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
 * The fingerprint-strategy and execution-mode cluster: values a TOOL AUTHOR declared, not
 * values a user configured. Same validation shape as {@link USER_CONFIGURATION}, different
 * audience and therefore a different exit class — overriding two axes on every member was
 * the tell that this is its own cluster.
 */
const TOOL_AUTHORED_DECLARATION = {
  ...USER_CONFIGURATION,
  defaultResponsibility: 'tool-author',
  exitClass: 'plugin-incompatible',
} as const satisfies Omit<ErrorDefinition, 'owner' | 'code' | 'operatorAction'>;

export const configAndRuntimeDefinitions = {
  /**
   * No `opensip-cli.config.yml` was found walking up from the working directory.
   *
   * `public` exposure is the entire point: the message enumerates the directories that were
   * checked, and that list is what makes the failure self-service.
   */
  'CONFIGURATION.CONFIG.NOT_FOUND': {
    ...USER_CONFIGURATION,
    code: 'CONFIGURATION.CONFIG.NOT_FOUND',
    kind: 'not-found',
    operatorAction:
      'Run `opensip init` to create opensip-cli.config.yml, or pass --config with the path to an existing one.',
  },

  /** An explicit `--config <path>` does not exist. Distinct from the discovery walk miss. */
  'CONFIGURATION.CONFIG.EXPLICIT_PATH_MISSING': {
    ...USER_CONFIGURATION,
    code: 'CONFIGURATION.CONFIG.EXPLICIT_PATH_MISSING',
    kind: 'not-found',
    operatorAction: 'Correct the --config path, or omit --config to discover the config file.',
  },

  /** A `--top` / `top:` value is not a non-negative integer. */
  'CONFIGURATION.AGENT_FILTER.INVALID_TOP': {
    ...USER_CONFIGURATION,
    code: 'CONFIGURATION.AGENT_FILTER.INVALID_TOP',
    operatorAction: 'Pass a non-negative whole number to --top.',
  },

  /** A `--filter` token was empty or whitespace. */
  'CONFIGURATION.AGENT_FILTER.EMPTY_TOKEN': {
    ...USER_CONFIGURATION,
    code: 'CONFIGURATION.AGENT_FILTER.EMPTY_TOKEN',
    operatorAction: 'Remove the empty --filter token, or give it a value.',
  },

  /**
   * A `category:` / `source:` / `file:` filter was supplied with no argument.
   *
   * Failing loud rather than degrading to a match-nothing predicate is the right call: a
   * silent empty result set is indistinguishable from a clean run.
   */
  'CONFIGURATION.AGENT_FILTER.MISSING_ARGUMENT': {
    ...USER_CONFIGURATION,
    code: 'CONFIGURATION.AGENT_FILTER.MISSING_ARGUMENT',
    operatorAction: 'Supply a value after the filter prefix, e.g. --filter category:security.',
    publicMetadataKeys: ['token'],
  },

  /** A `--filter` token is outside the closed vocabulary; the message enumerates it. */
  'CONFIGURATION.AGENT_FILTER.UNKNOWN_TOKEN': {
    ...USER_CONFIGURATION,
    code: 'CONFIGURATION.AGENT_FILTER.UNKNOWN_TOKEN',
    operatorAction: 'Use one of the filter tokens listed in the message.',
    publicMetadataKeys: ['token'],
  },

  /** `--gate-save` and `--gate-compare` were both supplied. */
  'CONFIGURATION.GATE.MUTUALLY_EXCLUSIVE_FLAGS': {
    ...USER_CONFIGURATION,
    code: 'CONFIGURATION.GATE.MUTUALLY_EXCLUSIVE_FLAGS',
    operatorAction: 'Pass either --gate-save or --gate-compare, not both.',
    publicMetadataKeys: ['flags'],
  },

  /** A tool's config namespace failed schema validation. Issue list rides on `cause`. */
  'CONFIGURATION.TOOL_NAMESPACE.PARSE_FAILED': {
    ...USER_CONFIGURATION,
    code: 'CONFIGURATION.TOOL_NAMESPACE.PARSE_FAILED',
    operatorAction:
      'Correct the named tool configuration block in opensip-cli.config.yml; the schema issues are listed on the error cause.',
    publicMetadataKeys: ['namespace'],
  },

  /** A tool's config namespace is present but is not a mapping. */
  'CONFIGURATION.TOOL_NAMESPACE.NOT_AN_OBJECT': {
    ...USER_CONFIGURATION,
    code: 'CONFIGURATION.TOOL_NAMESPACE.NOT_AN_OBJECT',
    operatorAction:
      'Make the named tool configuration block a mapping of keys to values, or remove it.',
    publicMetadataKeys: ['namespace'],
  },

  /** A fingerprint strategy declared an empty id. Tool-author, not user. */
  'CORE.BASELINE.FINGERPRINT_STRATEGY_INVALID_ID': {
    ...TOOL_AUTHORED_DECLARATION,
    code: 'CORE.BASELINE.FINGERPRINT_STRATEGY_INVALID_ID',
    operatorAction: 'Give the fingerprint strategy a non-empty id.',
  },

  /** A fingerprint strategy version is not a positive integer. */
  'CORE.BASELINE.FINGERPRINT_STRATEGY_INVALID_VERSION': {
    ...TOOL_AUTHORED_DECLARATION,
    code: 'CORE.BASELINE.FINGERPRINT_STRATEGY_INVALID_VERSION',
    operatorAction: 'Give the fingerprint strategy a positive integer version.',
  },

  /**
   * A fingerprint strategy descriptor's `fingerprint` is not a function.
   *
   * `defineFingerprintStrategy` validated the id and the version and then froze
   * `input.fingerprint` without ever checking it was callable — so the failure surfaced far
   * from the descriptor, inside the host's post-pass.
   */
  'CORE.BASELINE.FINGERPRINT_STRATEGY_INVALID_FINGERPRINT': {
    ...TOOL_AUTHORED_DECLARATION,
    code: 'CORE.BASELINE.FINGERPRINT_STRATEGY_INVALID_FINGERPRINT',
    operatorAction: 'Declare `fingerprint` as a function on the fingerprint strategy descriptor.',
  },

  /** A fingerprint strategy returned a value that is not a usable fingerprint string. */
  'CORE.BASELINE.FINGERPRINT_STRATEGY_FAILED': {
    ...USER_CONFIGURATION,
    code: 'CORE.BASELINE.FINGERPRINT_STRATEGY_FAILED',
    defaultResponsibility: 'tool-author',
    kind: 'invariant',
    severity: 'warning',
    exitClass: 'success',
    operatorAction:
      'The fingerprint strategy returned an unusable value; findings are reported un-stamped for this run. Report it to the tool author.',
    publicMetadataKeys: ['strategyId'],
  },

  /**
   * A workflow execution mode is not one of the supported values.
   *
   * `mode` originates in recipe-authored options, so this is a plugin-authored value
   * surfacing as a registered validation failure rather than a bare `Error`.
   */
  'VALIDATION.EXECUTION.INVALID_MODE': {
    ...TOOL_AUTHORED_DECLARATION,
    code: 'VALIDATION.EXECUTION.INVALID_MODE',
    operatorAction: 'Set the workflow execution mode to one of the documented values.',
    publicMetadataKeys: ['value'],
  },

  /**
   * An error definition or catalog failed validation.
   *
   * The catalog machinery's own failure. `redacted` because the only actionable audience is
   * whoever authored the catalog, and the message quotes their data.
   */
  'CORE.ERROR_DEFINITION.INVALID': {
    ...USER_CONFIGURATION,
    code: 'CORE.ERROR_DEFINITION.INVALID',
    defaultResponsibility: 'tool-author',
    exposure: 'redacted',
    exitClass: 'plugin-incompatible',
    operatorAction:
      'Correct the error definition or catalog named in the message; see the error-code index for the required shape.',
  },

  /**
   * A `git` subprocess failed.
   *
   * `execFileSync` failure was reduced to `{ ok: false }` with no bounded operator detail, so
   * a permission error, a 5 s timeout kill, an `ENOBUFS` overflow and a genuine non-zero git
   * exit were indistinguishable to both the operator and `--json` consumers. Degradation is
   * still the behaviour — changed-file detection falls back — so `warning`, but visible.
   */
  'CORE.SUBPROCESS.GIT_FAILED': {
    ...USER_CONFIGURATION,
    code: 'CORE.SUBPROCESS.GIT_FAILED',
    source: 'external',
    defaultResponsibility: 'environment',
    kind: 'I/O',
    retry: 'caller-policy',
    severity: 'warning',
    exitClass: 'success',
    operatorAction:
      'git could not be run, so changed-file detection is unavailable this run. Check that git is installed and the directory is a repository.',
    publicMetadataKeys: ['condition', 'exitCode'],
  },
} as const satisfies Record<string, Omit<ErrorDefinition, 'owner'>>;
