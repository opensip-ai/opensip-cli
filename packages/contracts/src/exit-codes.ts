import {
  ConfigurationError,
  NetworkError,
  NotFoundError,
  PluginIncompatibleError,
  TimeoutError,
  ToolError,
  ValidationError,
  normalizeFailure,
} from '@opensip-cli/core';

export const EXIT_CODES = {
  SUCCESS: 0,
  RUNTIME_ERROR: 1,
  CONFIGURATION_ERROR: 2,
  CHECK_NOT_FOUND: 3,
  REPORT_FAILED: 4,
  /**
   * A plugin was rejected by the compatibility gate (launch) — its
   * declared `apiVersion` is out of range and it was explicitly requested
   * (fail-closed; the skip path is silent). Dedicated rather than reusing
   * `CONFIGURATION_ERROR` so an incompatible plugin is diagnosable from the
   * exit code alone. Read by the CLI fail-closed admission path (Phase 3).
   */
  PLUGIN_INCOMPATIBLE: 5,
  /** Cooperative cancellation (SIGINT/SIGTERM after cleanup) — Plan 00. */
  CANCELLED: 130,
} as const;

/**
 * Map definition exitClass → numeric host exit (Plan 00). Preferred path when
 * a normalized failure / ToolError.definition is available.
 */
export function mapExitClassToExitCode(exitClass: string | undefined): number {
  switch (exitClass) {
    case 'success': {
      return EXIT_CODES.SUCCESS;
    }
    case 'configuration': {
      return EXIT_CODES.CONFIGURATION_ERROR;
    }
    case 'not-found': {
      return EXIT_CODES.CHECK_NOT_FOUND;
    }
    case 'report-failed': {
      return EXIT_CODES.REPORT_FAILED;
    }
    case 'plugin-incompatible': {
      return EXIT_CODES.PLUGIN_INCOMPATIBLE;
    }
    case 'cancelled': {
      return EXIT_CODES.CANCELLED;
    }
    case 'fatal': {
      return EXIT_CODES.RUNTIME_ERROR;
    }
    case 'runtime': {
      return EXIT_CODES.RUNTIME_ERROR;
    }
    default: {
      return EXIT_CODES.RUNTIME_ERROR;
    }
  }
}

/**
 * Canonical mapping from typed `ToolError` to CLI exit codes.
 *
 * Typed subclasses own exit codes via the instanceof ladder (ADR-0066) so a
 * detail subcode on `error.code` cannot demote a ConfigurationError or
 * PluginIncompatibleError to runtime/fatal. Base `ToolError` uses
 * {@link ToolError.definition}.exitClass (e.g. cooperative cancel → 130).
 *
 * For cross-copy branded failures without a shared prototype chain, prefer
 * {@link mapFailureToExitCode} which recognizes `isToolErrorLike` brands.
 */
export function mapToolErrorToExitCode(error: ToolError): number {
  // Subclass ladder first — stable for subcodes (CONFIGURATION.GATE.*, PLUGIN.WORKER.*, …).
  if (error instanceof NotFoundError) return EXIT_CODES.CHECK_NOT_FOUND;
  if (error instanceof ConfigurationError) return EXIT_CODES.CONFIGURATION_ERROR;
  if (error instanceof ValidationError) return EXIT_CODES.CONFIGURATION_ERROR;
  if (error instanceof NetworkError) return EXIT_CODES.REPORT_FAILED;
  if (error instanceof PluginIncompatibleError) return EXIT_CODES.PLUGIN_INCOMPATIBLE;
  if (error instanceof TimeoutError) return EXIT_CODES.RUNTIME_ERROR;

  const fromDefinition = error.definition?.exitClass;
  if (fromDefinition !== undefined) {
    return mapExitClassToExitCode(fromDefinition);
  }
  return EXIT_CODES.RUNTIME_ERROR;
}

/**
 * Total exit-code mapper for any thrown value (Plan 00).
 *
 * Precedence:
 * 1. Same-realm `ToolError` subclasses via {@link mapToolErrorToExitCode}
 * 2. Structural `isToolErrorLike` brands (duplicate physical `@opensip-cli/core`) → definition.exitClass
 * 3. {@link normalizeFailure} definition axes for natives/primitives/hostile input
 */
export function mapFailureToExitCode(error: unknown): number {
  try {
    if (error instanceof ToolError) {
      return mapToolErrorToExitCode(error);
    }
  } catch {
    // @swallow-ok probe/optional capability: hostile instanceof failure degrades
    // to the total unknown-definition normalizer below.
  }
  return mapExitClassToExitCode(normalizeFailure(error).definition.exitClass);
}

/**
 * Human-readable diagnosis for untyped errors. Advice only — exit codes come from
 * typed {@link mapToolErrorToExitCode}, Commander, or bootstrap errors.
 */
export interface ErrorSuggestion {
  message: string;
  action?: string;
}

/**
 * A suggestion-rule match result.
 *
 * `null` means "this rule did not match." A returned object signals a
 * match; the optional `capture` carries an arm-specific string the
 * suggest builder will format into the message (e.g. the missing check
 * slug, or the verbatim error message for the unknown-recipe rule).
 */
interface SuggestionMatch {
  capture: string | null;
}

interface SuggestionRule {
  match: (message: string) => SuggestionMatch | null;
  suggest: (capture: string | null) => ErrorSuggestion;
}

/**
 * True when any of the supplied substrings appear in `message`.
 *
 * Wraps the substring checks the rule table needs without spreading
 * `String#includes` ladders back through `getErrorSuggestion`. Each
 * rule keeps its own readable list of substrings and the function
 * body stays a pure data walk.
 */
function containsAny(haystack: string, needles: readonly string[]): boolean {
  return needles.some((needle) => haystack.includes(needle));
}

/**
 * Ordered list of suggestion rules. Walked top-down by
 * `getErrorSuggestion`; first hit wins, so order is load-bearing.
 *
 * Adding a new error category is one tuple. Do NOT replace this with
 * a Chain-of-Responsibility class — a flat array is the contract here.
 *
 * The over-broad bare `'config'` substring from the previous
 * implementation has been narrowed into two explicit rules — one for
 * `opensip-cli.config.yml` (file shape) and one for `YAML` (parse
 * shape). The bare substring matched common English words like
 * `'configurable'` and `'reconfigure'` and produced false positives.
 */
const SUGGESTION_RULES: readonly SuggestionRule[] = [
  // Recipe not found — must come BEFORE the check-not-found rule because
  // the fitness engine throws `Recipe not found: <id>` and the broad
  // `/not found: (.+)/` regex would otherwise mis-classify it as
  // CHECK_NOT_FOUND (exit 3) instead of CONFIGURATION_ERROR (exit 2).
  {
    match: (message) => {
      const recipeRegex = /Recipe not found: (.+)/;
      const m = recipeRegex.exec(message);
      if (m) return { capture: m[1] ?? null };
      if (containsAny(message, ['Recipe not found:'])) return { capture: null };
      return null;
    },
    suggest: (capture) => ({
      message: `Recipe '${capture ?? 'unknown'}' not found.`,
      action: 'Run opensip fit --recipes to see available recipes.',
    }),
  },

  // Check not found — only the explicit "Check not found: <slug>" form (plus
  // the substring for no-capture cases). We deliberately dropped the previous
  // broad `/not found: (.+)/` and bare "not found" contains check to avoid
  // mis-classifying other "not found" errors (recipes, files, symbols, etc.)
  // as CHECK_NOT_FOUND via the string suggestion path. The *typed* mapper
  // (mapToolErrorToExitCode) already routes real NotFoundError correctly; this
  // table is only for unstructured Error messages.
  {
    match: (message) => {
      const slugMatch = /Check not found: (.+)/.exec(message);
      if (slugMatch) {
        return { capture: slugMatch[1] };
      }
      if (containsAny(message, ['Check not found:'])) {
        return { capture: null };
      }
      return null;
    },
    suggest: (capture) => ({
      message: `Check '${capture ?? 'unknown'}' not found.`,
      action: 'Run opensip fit --list to see available checks.',
    }),
  },

  // Recipe not found — captures the verbatim error message so the
  // surfaced suggestion preserves the recipe name.
  {
    match: (message) => (containsAny(message, ['Unknown recipe']) ? { capture: message } : null),
    suggest: (capture) => ({
      message: capture ?? 'Unknown recipe.',
      action: 'Run opensip fit --recipes to see available recipes.',
    }),
  },

  // Config file error — opensip-cli.config.yml shape.
  {
    match: (message) =>
      containsAny(message, ['opensip-cli.config.yml']) ? { capture: null } : null,
    suggest: () => ({
      message: 'Configuration error.',
      action: 'Check opensip-cli.config.yml for syntax errors.',
    }),
  },

  // Config file error — YAML parse shape (paired with the file rule above).
  {
    match: (message) => (containsAny(message, ['YAML']) ? { capture: null } : null),
    suggest: () => ({
      message: 'Configuration error.',
      action: 'Check opensip-cli.config.yml for syntax errors.',
    }),
  },

  // Permission denied
  {
    match: (message) =>
      containsAny(message, ['EACCES', 'permission denied']) ? { capture: null } : null,
    suggest: () => ({
      message: 'Permission denied reading files.',
      action: 'Check file permissions in the target directory.',
    }),
  },

  // No checks available
  {
    match: (message) =>
      containsAny(message, ['No checks registered', 'No checks to run']) ? { capture: null } : null,
    suggest: () => ({
      message: 'No checks available to run.',
      action:
        'Install at least one @opensip-cli/checks-* package, or declare plugins.checkPackages in opensip-cli.config.yml.',
    }),
  },

  // Network error (report-to)
  {
    match: (message) =>
      containsAny(message, ['fetch', 'ECONNREFUSED', 'network']) ? { capture: null } : null,
    suggest: () => ({
      message: 'Network error sending report.',
      action: 'Check the --report-to URL and your network connection.',
    }),
  },
];

/**
 * LAST-RESORT message/action advice for UNSTRUCTURED errors — a bare `Error`/string
 * with no type to map from. The typed {@link mapToolErrorToExitCode} is
 * authoritative for any `ToolError`; untyped errors always exit `RUNTIME_ERROR`.
 * Returns null if no rule fires.
 */
export function getErrorSuggestion(err: unknown): ErrorSuggestion | null {
  return getErrorSuggestionFromMessage(normalizeFailure(err).message);
}

/**
 * Evaluate the narrow legacy suggestion table against an already-normalized
 * message. Host fan-out paths use this overload so one caught value is never
 * normalized repeatedly by independent presentation helpers.
 */
export function getErrorSuggestionFromMessage(message: string): ErrorSuggestion | null {
  for (const rule of SUGGESTION_RULES) {
    const result = rule.match(message);
    if (result !== null) {
      return rule.suggest(result.capture);
    }
  }

  return null;
}
