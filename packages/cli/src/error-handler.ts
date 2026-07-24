/**
 * error-handler — single-responsibility catch handler for the
 * top-level `parseAsync().catch(...)` block.
 *
 * Goals:
 *  - One `process.exitCode` write path: route every exit-code change
 *    through the supplied `setExitCode` callback (which `cli-context.ts`
 *    centralises).
 *  - Normalize a caught value once and derive public wording, catalog action,
 *    machine outcome, and definition-owned exit class from that envelope.
 *  - Retain the narrow legacy suggestion table only for otherwise-unknown
 *    errors; known definitions own their action and never need message matching.
 *  - Keep the renderer pluggable so unit tests can capture the rendered
 *    `ErrorResult` without touching Ink.
 */

import {
  EXIT_CODES,
  getErrorSuggestionFromMessage,
  mapExitClassToExitCode,
  type ErrorResult,
} from '@opensip-cli/contracts';
import {
  neutralizeTerminalText,
  normalizeFailure,
  toOperatorFailureProjection,
  toPublicFailureProjection,
} from '@opensip-cli/core';
import { CommanderError } from 'commander';

import { BootstrapError } from './bootstrap/bootstrap-error.js';
import {
  outcomeFromErrorMessage,
  outcomeFromFailureEnvelope,
} from './commands/assemble-outcome.js';
import { renderOutcome } from './commands/render-outcome.js';

/**
 * Commander error codes that denote an INVALID ARGUMENT VALUE — a declared
 * `choices` rejection or a custom `argParser` that threw `InvalidArgumentError`
 * (e.g. graph's `--resolution` once its value validation moved from an
 * in-handler `ValidationError` to a declarative `choices` in the launch command
 * plane). These are usage errors and must exit `CONFIGURATION_ERROR` (2) — the
 * same code `mapToolErrorToExitCode(ValidationError)` yields — preserving the
 * pre-command-plane contract. Every OTHER Commander code (unknown command /
 * option, missing argument, help/version display) keeps Commander's own
 * `exitCode`, which already matched launch.
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

export interface HandleParseErrorOptions {
  readonly setExitCode: (code: number) => void;
  readonly render: (result: ErrorResult) => Promise<void>;
  /**
   * Whether `--json` was requested (read from argv at the composition root —
   * these errors fire outside a handler, so no parsed opts are available). When
   * true, every error becomes a structured `CommandOutcome` on stdout (the
   * `one-outcome-shape` contract, §5.5); when false, human rendering is
   * byte-identical to launch.
   */
  readonly jsonRequested: boolean;
}

/** Inert renderer for the `--json` paths — `renderOutcome` never renders in JSON mode. */
const NOOP_RENDER = (): Promise<void> => Promise.resolve();

function safeInstanceOf<T>(value: unknown, ctor: abstract new (...args: never[]) => T): value is T {
  try {
    return value instanceof ctor;
  } catch {
    return false;
  }
}

/**
 * The catch handler for `program.parseAsync()`. Maps the thrown error to a
 * `CommandOutcome` (launch, §5.5): `--json` emits the structured outcome
 * on stdout, human mode renders byte-identically to launch. Routes the exit code
 * through `setExitCode`. Never throws.
 */
export async function handleParseError(
  error: unknown,
  opts: HandleParseErrorOptions,
): Promise<void> {
  // Commander's own parse failures (surfaced because the root program calls
  // `.exitOverride()`). Commander has ALREADY written its error/usage line to
  // stderr (or the help text to stdout), so we set the exit code and render
  // nothing — re-rendering would duplicate Commander's output and regress the
  // legacy-identical stderr for unknown-command/option/missing-arg cases. Only
  // the invalid-argument-value codes are re-mapped to exit 2 (ValidationError
  // parity); every other code keeps Commander's exit code.
  if (safeInstanceOf(error, CommanderError)) {
    opts.setExitCode(commanderExitCode(error));
    return;
  }

  // Pre-handler bootstrap failures (§4.7): no-project, schema-too-old,
  // config-resolve, tool-init. The guard threw a typed BootstrapError carrying its
  // own exit code, a clean message, and the original multi-line human text. In
  // human mode we write that text to stderr verbatim — byte-identical to the
  // legacy guard output; in `--json` we emit a structured `bootstrap.error`.
  if (safeInstanceOf(error, BootstrapError)) {
    opts.setExitCode(error.exitCode);
    if (opts.jsonRequested) {
      await renderOutcome(
        outcomeFromErrorMessage({
          message: error.message,
          exitCode: error.exitCode,
          kind: 'bootstrap.error',
          ...(error.suggestion ? { suggestion: error.suggestion } : {}),
        }),
        { jsonRequested: true, render: NOOP_RENDER },
      );
    } else {
      process.stderr.write(`${error.humanMessage}\n`);
    }
    return;
  }

  const envelope = normalizeFailure(error);
  const failure = toPublicFailureProjection(envelope);
  const message = typeof failure.message === 'string' ? failure.message : 'The operation failed.';
  const legacySuggestion = getErrorSuggestionFromMessage(envelope.message);
  const action = envelope.known === 'known' ? envelope.operatorAction : legacySuggestion?.action;
  const exitCode = mapExitClassToExitCode(envelope.definition.exitClass);
  opts.setExitCode(exitCode);
  if (opts.jsonRequested) {
    await renderOutcome(outcomeFromFailureEnvelope(envelope, { kind: 'command.error' }), {
      jsonRequested: true,
      render: NOOP_RENDER,
    });
    return;
  }
  await opts.render({
    type: 'error',
    message,
    ...(action === undefined ? {} : { suggestion: action }),
    exitCode,
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
 * Exit code comes from the normalized definition, including structurally
 * recognized duplicate-core ToolErrors and the plugin-incompatible class.
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
  const envelope = normalizeFailure(error);
  const publicProjection = toPublicFailureProjection(envelope);
  const operatorProjection = toOperatorFailureProjection(envelope);
  const message =
    typeof publicProjection.message === 'string'
      ? neutralizeTerminalText(publicProjection.message)
      : 'The operation failed.';
  const exitCode = mapExitClassToExitCode(envelope.definition.exitClass);
  try {
    process.stderr.write(`opensip: fatal error [${envelope.code}]: ${message}\n`);
  } catch {
    // @swallow-ok intentional degradation: a broken stderr cannot prevent the deterministic fatal status.
  }
  try {
    log.error({
      evt: 'cli.bootstrap.failed',
      module: 'cli:bootstrap',
      code: envelope.code,
      exitCode,
      failure: operatorProjection,
    });
  } catch {
    // @swallow-ok cleanup/observer isolation: logging cannot replace the primary failure or exit status.
  }
  try {
    process.exitCode = exitCode;
  } catch {
    // @swallow-ok intentional degradation: no remaining effect is safe if the host rejects exitCode assignment.
  }
}
