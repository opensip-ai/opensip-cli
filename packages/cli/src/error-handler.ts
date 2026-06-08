/**
 * error-handler — single-responsibility catch handler for the
 * top-level `parseAsync().catch(...)` block.
 *
 * Goals:
 *  - One `process.exitCode` write path: route every exit-code change
 *    through the supplied `setExitCode` callback (which `cli-context.ts`
 *    centralises).
 *  - Match on `instanceof` against the typed error hierarchy in
 *    `@opensip-tools/core`; fall back to the data-driven
 *    `getErrorSuggestion` (Layer 2 Phase 1) for unknown shapes.
 *  - The typed-error → exit-code policy lives in contracts'
 *    `mapToolErrorToExitCode` (audit-round-2 Finding C). This handler
 *    keeps only the *CLI-specific* layer: per-class action hints (e.g.
 *    "Run opensip-tools fit --list...") that don't belong in the
 *    headless contracts package.
 *  - Keep the renderer pluggable so unit tests can capture the rendered
 *    `ErrorResult` without touching Ink.
 */

import {
  EXIT_CODES,
  getErrorSuggestion,
  mapToolErrorToExitCode,
  type ErrorResult,
  type ErrorSuggestion,
} from '@opensip-tools/contracts';
import {
  ConfigurationError,
  NetworkError,
  NotFoundError,
  PluginIncompatibleError,
  ToolError,
} from '@opensip-tools/core';
import { CommanderError } from 'commander';

/**
 * Commander error codes that denote an INVALID ARGUMENT VALUE — a declared
 * `choices` rejection or a custom `argParser` that threw `InvalidArgumentError`
 * (e.g. graph's `--resolution` once its value validation moved from an
 * in-handler `ValidationError` to a declarative `choices` in the 2.11.0 command
 * plane). These are usage errors and must exit `CONFIGURATION_ERROR` (2) — the
 * same code `mapToolErrorToExitCode(ValidationError)` yields — preserving the
 * pre-command-plane contract. Every OTHER Commander code (unknown command /
 * option, missing argument, help/version display) keeps Commander's own
 * `exitCode`, which already matched 2.10.0.
 */
const COMMANDER_INVALID_ARGUMENT_CODES: ReadonlySet<string> = new Set([
  'commander.invalidArgument',
  'commander.invalidOptionArgument',
]);

/**
 * Map a Commander `exitOverride` error to an exit code, re-mapping only the
 * invalid-argument-value codes to `CONFIGURATION_ERROR` (2) to match the typed
 * `ValidationError` semantics the declarative `choices` replaced. All other
 * Commander conditions retain Commander's own `exitCode`.
 */
function commanderExitCode(error: CommanderError): number {
  return COMMANDER_INVALID_ARGUMENT_CODES.has(error.code)
    ? EXIT_CODES.CONFIGURATION_ERROR
    : error.exitCode;
}

/**
 * Per-class action hints. Adding a new ToolError subclass with a
 * suggested user action is one tuple here; the exit code comes from
 * `mapToolErrorToExitCode` so the policy stays in one place.
 */
const ACTION_HINTS: readonly {
  readonly is: (e: ToolError) => boolean;
  readonly action: string;
}[] = [
  {
    is: (e) => e instanceof NotFoundError,
    action: 'Run opensip-tools fit --list to see available checks.',
  },
  {
    is: (e) => e instanceof ConfigurationError,
    action: 'Check opensip-tools.config.yml or your --language flag.',
  },
  {
    is: (e) => e instanceof NetworkError,
    action: 'Check the --report-to URL and your network connection.',
  },
  {
    is: (e) => e instanceof PluginIncompatibleError,
    action:
      'Upgrade opensip-tools (or the tool), or allowlist a project-local tool via OPENSIP_TOOLS_ALLOW_PROJECT_TOOLS.',
  },
];

function suggestionFromTypedError(error: unknown): ErrorSuggestion | null {
  if (!(error instanceof ToolError)) return null;
  const hint = ACTION_HINTS.find((rule) => rule.is(error));
  return {
    message: error.message,
    ...(hint ? { action: hint.action } : {}),
    exitCode: mapToolErrorToExitCode(error),
  };
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
  // Commander's own parse failures (surfaced because the root program calls
  // `.exitOverride()`). Commander has ALREADY written its error/usage line to
  // stderr (or the help text to stdout), so we set the exit code and render
  // nothing — re-rendering would duplicate Commander's output and regress the
  // 2.10.0-identical stderr for unknown-command/option/missing-arg cases. Only
  // the invalid-argument-value codes are re-mapped to exit 2 (ValidationError
  // parity); every other code keeps Commander's exit code.
  if (error instanceof CommanderError) {
    opts.setExitCode(commanderExitCode(error));
    return;
  }

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
 * I/O). Sets `process.exitCode` (not `process.exit(N)` — the latter
 * skips the pending stderr flush, and any structured-logging hook on
 * bootstrap failure has nowhere to attach), writes the error line to
 * stderr, and emits a `cli.bootstrap.failed` log event so observability
 * pipelines see the failure. Audit 2026-05-23 G1.
 *
 * Exit code: a typed `ToolError` (e.g. the `PluginIncompatibleError` the
 * Phase-3 fail-closed admission path throws) routes through the canonical
 * `mapToolErrorToExitCode` policy so a fail-closed plugin yields exit 5
 * (`PLUGIN_INCOMPATIBLE`) even when it surfaces from bootstrap rather than
 * Commander's parse loop. Untyped errors keep the historical exit 1.
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
  const exitCode =
    error instanceof ToolError ? mapToolErrorToExitCode(error) : EXIT_CODES.RUNTIME_ERROR;
  process.stderr.write(`opensip-tools: fatal error: ${message}\n`);
  log.error({
    evt: 'cli.bootstrap.failed',
    module: 'cli:bootstrap',
    error: message,
    exitCode,
    stack: error instanceof Error ? error.stack : undefined,
  });
  process.exitCode = exitCode;
}
