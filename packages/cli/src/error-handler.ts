/**
 * error-handler — single-responsibility catch handler for the
 * top-level `parseAsync().catch(...)` block.
 *
 * Goals:
 *  - One `process.exitCode` write path: route every exit-code change
 *    through the supplied `setExitCode` callback (which `cli-context.ts`
 *    centralises).
 *  - Match on `instanceof` first against the typed error hierarchy in
 *    `@opensip-tools/core`; fall back to the data-driven
 *    `getErrorSuggestion` (Layer 2 Phase 1) for unknown shapes.
 *  - Keep the renderer pluggable so unit tests can capture the rendered
 *    `ErrorResult` without touching Ink.
 */

import {
  EXIT_CODES,
  getErrorSuggestion,
  type ErrorResult,
  type ErrorSuggestion,
} from '@opensip-tools/contracts';
import {
  ConfigurationError,
  NetworkError,
  NotFoundError,
  TimeoutError,
  ValidationError,
  type ToolError,
} from '@opensip-tools/core';

/**
 * Static map from typed-error class to the suggestion shape the CLI
 * surfaces. The catch handler walks this list top-down using
 * `instanceof`. Adding a new typed error to core is one line here.
 */
interface TypedErrorRule {
  /** `instanceof` test — matches the typed error class hierarchy. */
  readonly is: (error: unknown) => boolean;
  /** Build the `ErrorSuggestion` for a matched error. */
  readonly build: (error: ToolError) => ErrorSuggestion;
}

const TYPED_ERROR_RULES: readonly TypedErrorRule[] = [
  {
    is: (error) => error instanceof NotFoundError,
    build: (error) => ({
      message: error.message,
      action: 'Run opensip-tools fit --list to see available checks.',
      exitCode: EXIT_CODES.CHECK_NOT_FOUND,
    }),
  },
  {
    is: (error) => error instanceof ConfigurationError,
    build: (error) => ({
      message: error.message,
      action: 'Check opensip-tools.config.yml or your --language flag.',
      exitCode: EXIT_CODES.CONFIGURATION_ERROR,
    }),
  },
  {
    is: (error) => error instanceof ValidationError,
    build: (error) => ({
      message: error.message,
      exitCode: EXIT_CODES.CONFIGURATION_ERROR,
    }),
  },
  {
    is: (error) => error instanceof NetworkError,
    build: (error) => ({
      message: error.message,
      action: 'Check the --report-to URL and your network connection.',
      exitCode: EXIT_CODES.REPORT_FAILED,
    }),
  },
  {
    is: (error) => error instanceof TimeoutError,
    build: (error) => ({
      message: error.message,
      exitCode: EXIT_CODES.RUNTIME_ERROR,
    }),
  },
];

function suggestionFromTypedError(error: unknown): ErrorSuggestion | null {
  for (const rule of TYPED_ERROR_RULES) {
    if (rule.is(error)) {
      return rule.build(error as ToolError);
    }
  }
  return null;
}

export interface HandleParseErrorOptions {
  readonly setExitCode: (code: number) => void;
  readonly render: (result: ErrorResult) => Promise<void>;
}

/**
 * The catch handler for `program.parseAsync()`. Maps the thrown error
 * to an `ErrorResult`, routes the exit code through `setExitCode`, and
 * renders the error via the supplied renderer. Never throws.
 */
export async function handleParseError(
  error: unknown,
  opts: HandleParseErrorOptions,
): Promise<void> {
  const typed = suggestionFromTypedError(error);
  const suggestion = typed ?? getErrorSuggestion(error);

  if (suggestion) {
    opts.setExitCode(suggestion.exitCode);
    await opts.render({
      type: 'error',
      message: suggestion.message,
      suggestion: suggestion.action,
      exitCode: suggestion.exitCode,
    });
    return;
  }

  const message = error instanceof Error ? error.message : String(error);
  opts.setExitCode(EXIT_CODES.RUNTIME_ERROR);
  await opts.render({
    type: 'error',
    message,
    exitCode: EXIT_CODES.RUNTIME_ERROR,
  });
}

/**
 * Top-level fatal-error handler for failures BEFORE Commander's parse
 * loop runs (bootstrap registration, dynamic plugin imports, preflight
 * I/O). Sets `process.exitCode = 1` (not `process.exit(N)` — the latter
 * skips the pending stderr flush, and any structured-logging hook on
 * bootstrap failure has nowhere to attach), writes the error line to
 * stderr, and emits a `cli.bootstrap.failed` log event so observability
 * pipelines see the failure. Audit 2026-05-23 G1.
 *
 * Synchronous because every step here is sync — stderr write,
 * structured-log call, exit-code set. The top-level caller doesn't
 * need to `await` it (Node exits naturally with the configured
 * `process.exitCode` after the event loop drains), but the call site
 * is fine to `await` either way.
 */
export function handleFatalBootstrapError(
  error: unknown,
  log: { error: (entry: Record<string, unknown>) => void },
): void {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`opensip-tools: fatal error: ${message}\n`);
  log.error({
    evt: 'cli.bootstrap.failed',
    module: 'cli:bootstrap',
    error: message,
    stack: error instanceof Error ? error.stack : undefined,
  });
  process.exitCode = EXIT_CODES.RUNTIME_ERROR;
}
