import {
  ConfigurationError,
  NetworkError,
  NotFoundError,
  PluginIncompatibleError,
  TimeoutError,
  ValidationError,
  type ToolError,
} from '@opensip-tools/core';

export const EXIT_CODES = {
  SUCCESS: 0,
  RUNTIME_ERROR: 1,
  CONFIGURATION_ERROR: 2,
  CHECK_NOT_FOUND: 3,
  REPORT_FAILED: 4,
  /**
   * A plugin was rejected by the compatibility gate (release 2.8.0) — its
   * declared `apiVersion` is out of range and it was explicitly requested
   * (fail-closed; the skip path is silent). Dedicated rather than reusing
   * `CONFIGURATION_ERROR` so an incompatible plugin is diagnosable from the
   * exit code alone. Read by the CLI fail-closed admission path (Phase 3).
   */
  PLUGIN_INCOMPATIBLE: 5,
} as const;

/**
 * Canonical mapping from typed `ToolError` subclasses to CLI exit
 * codes. This is the single source of truth for how typed errors flow
 * into the process exit code — both the CLI's top-level
 * `handleParseError` and any tool that chooses to handle its own
 * `ToolError` locally route through this function.
 *
 * The mapping policy (see `Tool` interface JSDoc in
 * `@opensip-tools/core` for the full contract):
 *
 *   - `NotFoundError`       → `CHECK_NOT_FOUND` (exit 3)
 *   - `ConfigurationError`  → `CONFIGURATION_ERROR` (exit 2)
 *   - `ValidationError`     → `CONFIGURATION_ERROR` (exit 2)
 *   - `NetworkError`           → `REPORT_FAILED` (exit 4)
 *   - `PluginIncompatibleError`→ `PLUGIN_INCOMPATIBLE` (exit 5)
 *   - `TimeoutError`           → `RUNTIME_ERROR` (exit 1)
 *   - any other `ToolError`    → `RUNTIME_ERROR` (exit 1)
 */
export function mapToolErrorToExitCode(error: ToolError): number {
  if (error instanceof NotFoundError) return EXIT_CODES.CHECK_NOT_FOUND;
  if (error instanceof ConfigurationError) return EXIT_CODES.CONFIGURATION_ERROR;
  if (error instanceof ValidationError) return EXIT_CODES.CONFIGURATION_ERROR;
  if (error instanceof NetworkError) return EXIT_CODES.REPORT_FAILED;
  if (error instanceof PluginIncompatibleError) return EXIT_CODES.PLUGIN_INCOMPATIBLE;
  if (error instanceof TimeoutError) return EXIT_CODES.RUNTIME_ERROR;
  return EXIT_CODES.RUNTIME_ERROR;
}

/** Human-readable diagnosis surfaced when a tool fails, with the exit code it maps to. */
export interface ErrorSuggestion {
  message: string;
  action?: string;
  exitCode: number;
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
 * `opensip-tools.config.yml` (file shape) and one for `YAML` (parse
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
      action: 'Run opensip-tools fit --recipes to see available recipes.',
      exitCode: EXIT_CODES.CONFIGURATION_ERROR,
    }),
  },

  // Check not found — captures the slug from "Check not found: <slug>"
  // or the bare "not found: <slug>" form. The recipe-not-found rule
  // above runs first to avoid mis-routing the recipe variant.
  {
    match: (message) => {
      const slugMatch =
        /Check not found: (.+)/.exec(message) ?? /not found: (.+)/.exec(message);
      if (slugMatch) {
        return { capture: slugMatch[1] };
      }
      // Substring forms with no extractable slug still match the rule;
      // the suggest builder substitutes "unknown".
      if (containsAny(message, ['Check not found:', 'not found'])) {
        return { capture: null };
      }
      return null;
    },
    suggest: (capture) => ({
      message: `Check '${capture ?? 'unknown'}' not found.`,
      action: 'Run opensip-tools fit --list to see available checks.',
      exitCode: EXIT_CODES.CHECK_NOT_FOUND,
    }),
  },

  // Recipe not found — captures the verbatim error message so the
  // surfaced suggestion preserves the recipe name.
  {
    match: (message) =>
      containsAny(message, ['Unknown recipe']) ? { capture: message } : null,
    suggest: (capture) => ({
      message: capture ?? 'Unknown recipe.',
      action: 'Run opensip-tools fit --recipes to see available recipes.',
      exitCode: EXIT_CODES.CONFIGURATION_ERROR,
    }),
  },

  // Config file error — opensip-tools.config.yml shape.
  {
    match: (message) =>
      containsAny(message, ['opensip-tools.config.yml']) ? { capture: null } : null,
    suggest: () => ({
      message: 'Configuration error.',
      action: 'Check opensip-tools.config.yml for syntax errors.',
      exitCode: EXIT_CODES.CONFIGURATION_ERROR,
    }),
  },

  // Config file error — YAML parse shape (paired with the file rule above).
  {
    match: (message) =>
      containsAny(message, ['YAML']) ? { capture: null } : null,
    suggest: () => ({
      message: 'Configuration error.',
      action: 'Check opensip-tools.config.yml for syntax errors.',
      exitCode: EXIT_CODES.CONFIGURATION_ERROR,
    }),
  },

  // Permission denied
  {
    match: (message) =>
      containsAny(message, ['EACCES', 'permission denied'])
        ? { capture: null }
        : null,
    suggest: () => ({
      message: 'Permission denied reading files.',
      action: 'Check file permissions in the target directory.',
      exitCode: EXIT_CODES.RUNTIME_ERROR,
    }),
  },

  // No checks available
  {
    match: (message) =>
      containsAny(message, ['No checks registered', 'No checks to run'])
        ? { capture: null }
        : null,
    suggest: () => ({
      message: 'No checks available to run.',
      action:
        'Install at least one @opensip-tools/checks-* package, or declare plugins.checkPackages in opensip-tools.config.yml.',
      exitCode: EXIT_CODES.RUNTIME_ERROR,
    }),
  },

  // Network error (report-to)
  {
    match: (message) =>
      containsAny(message, ['fetch', 'ECONNREFUSED', 'network'])
        ? { capture: null }
        : null,
    suggest: () => ({
      message: 'Network error sending report.',
      action: 'Check the --report-to URL and your network connection.',
      exitCode: EXIT_CODES.REPORT_FAILED,
    }),
  },
];

/** Matches an arbitrary error against the suggestion-rule table; returns null if no rule fires. */
export function getErrorSuggestion(err: unknown): ErrorSuggestion | null {
  const message = err instanceof Error ? err.message : String(err);

  for (const rule of SUGGESTION_RULES) {
    const result = rule.match(message);
    if (result !== null) {
      return rule.suggest(result.capture);
    }
  }

  return null;
}
