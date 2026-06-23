/**
 * assemble-outcome — the host-owned assembler that STAMPS a {@link CommandOutcome}
 * onto a handler's pure-domain return (launch, north-star §5.5).
 *
 * The single load-bearing rule of the Output plane: **the host assembles, the
 * handler stays pure domain.** A tool handler returns (or hands the host) its
 * `SignalEnvelope` / `CommandResult` / a bare JSON document / an error message;
 * THIS module turns that into the one outer currency by deriving `kind`,
 * `status`, `exitCode`, the structured `errors`, AND stamping the scope-owned
 * `diagnostics` snapshot. The handler never constructs a `CommandOutcome` (it
 * cannot — the diagnostics bus is scope-collected). This keeps every tool,
 * first-party or external, off the privilege of choosing its own error JSON or
 * success carrier.
 *
 * No stdout here — the builders only read the current scope's diagnostics bus.
 * {@link renderOutcome} (the sibling) is the one place an outcome reaches a stream.
 */

import {
  EXIT_CODES,
  getErrorSuggestion,
  mapToolErrorToExitCode,
  type CliDiagnostic,
  type CommandOutcome,
  type ErrorDetail,
  type ErrorResult,
  type SignalEnvelope,
} from '@opensip-cli/contracts';
import { ToolError, currentScope } from '@opensip-cli/core';

/**
 * Attach the scope-owned diagnostics snapshot (north-star §5.10) to a freshly
 * built outcome. The host stamps it here — a handler never assembles diagnostics
 * (it cannot: the bus is scope-collected). Omitted entirely when no scope is
 * bound (isolated unit tests) or the bus is empty-and-untraced, keeping the
 * outcome shape minimal.
 */
function withDiagnostics(outcome: CommandOutcome): CommandOutcome {
  const diagnostics = currentScope()?.diagnostics?.snapshot();
  if (diagnostics === undefined) return outcome;
  return { ...outcome, diagnostics };
}

/** Derive a run outcome's `kind` from the envelope's tool id: `'<tool>.run'`. */
export function kindFromEnvelope(envelope: SignalEnvelope): string {
  return `${envelope.tool}.run`;
}

/**
 * Derive a result outcome's `kind` from a `CommandResult`'s discriminant
 * (`result.type`, e.g. `'history'` → `'history'`), falling back to a neutral
 * `'command.result'` for bare JSON documents that carry no `type`.
 */
export function kindFromResult(value: unknown): string {
  const type = (value as { readonly type?: unknown } | null)?.type;
  return typeof type === 'string' ? type : 'command.result';
}

/**
 * Wrap a completed run's {@link SignalEnvelope} as a `status:'ok'` outcome — the
 * envelope rides UNCHANGED under `.envelope` (the byte-identical inner currency;
 * the break is purely this new outer wrapper). `status` is `'ok'` for any run
 * that completed: a failing gate is a successful run with a non-zero `exitCode`,
 * and the gate verdict is read from `.envelope.verdict`, not the outer status.
 */
export function outcomeFromEnvelope(envelope: SignalEnvelope, exitCode: number): CommandOutcome {
  return withDiagnostics({ kind: kindFromEnvelope(envelope), status: 'ok', exitCode, envelope });
}

/**
 * Wrap a `CommandResult` (or a bare JSON document) as `.data`. An `ErrorResult`
 * (`type:'error'`) becomes a `status:'error'` outcome carrying its own
 * `exitCode` + a structured `errors` entry; everything else is `status:'ok'` with
 * the supplied `exitCode`.
 */
export function outcomeFromResult(value: unknown, exitCode: number): CommandOutcome {
  if ((value as { readonly type?: unknown } | null)?.type === 'error') {
    const err = value as ErrorResult;
    return withDiagnostics(errorOutcomeFromDetail(err, err.exitCode, value));
  }
  return withDiagnostics({ kind: kindFromResult(value), status: 'ok', exitCode, data: value });
}

/**
 * Build a `status:'error'` outcome from a thrown error — the host's error
 * stamper. A typed {@link ToolError} maps to its canonical exit code
 * (`mapToolErrorToExitCode`) and contributes its `code`; an untyped error is a
 * `RUNTIME_ERROR` (exit 1). The actionable `suggestion` comes from the shared
 * `getErrorSuggestion` rule table — the same diagnosis the legacy
 * `handleParseError` surfaced.
 *
 * @param kind The outcome kind (e.g. `'bootstrap.error'` for a pre-handler
 *   failure, Phase 3); defaults to `'command.error'`.
 */
export function outcomeFromError(
  error: unknown,
  opts: { readonly kind?: string } = {},
): CommandOutcome {
  const message = error instanceof Error ? error.message : String(error);
  const suggestion = getErrorSuggestion(error)?.action;
  const detail: ErrorDetail = {
    message,
    ...(suggestion ? { suggestion } : {}),
    ...(error instanceof ToolError ? { code: error.code } : {}),
  };
  const exitCode =
    error instanceof ToolError ? mapToolErrorToExitCode(error) : EXIT_CODES.RUNTIME_ERROR;
  return withDiagnostics({
    kind: opts.kind ?? 'command.error',
    status: 'error',
    exitCode,
    errors: [detail],
  });
}

/**
 * Build a `status:'error'` outcome from an already-resolved message + exit code —
 * the seam tool handlers use when they have a diagnosed failure (the former
 * `emitJson({ error })` shape) rather than a thrown error to map.
 */
export function outcomeFromErrorMessage(opts: {
  readonly message: string;
  readonly exitCode: number;
  readonly suggestion?: string;
  /** Optional machine-readable error category, surfaced as `ErrorDetail.code`. */
  readonly code?: string;
  readonly diagnostic?: CliDiagnostic;
  readonly kind?: string;
}): CommandOutcome {
  return withDiagnostics(
    errorOutcomeFromDetail(
      {
        message: opts.message,
        exitCode: opts.exitCode,
        ...(opts.suggestion === undefined ? {} : { suggestion: opts.suggestion }),
        ...(opts.code === undefined ? {} : { code: opts.code }),
        ...(opts.diagnostic === undefined ? {} : { diagnostic: opts.diagnostic }),
      },
      opts.exitCode,
      undefined,
      opts.kind,
    ),
  );
}

function errorOutcomeFromDetail(
  detail: {
    readonly message: string;
    readonly exitCode: number;
    readonly suggestion?: string;
    readonly code?: string;
    readonly diagnostic?: CliDiagnostic;
  },
  exitCode: number,
  data?: unknown,
  kind = 'command.error',
): CommandOutcome {
  const commandError = detail.diagnostic;
  return {
    kind,
    status: 'error',
    exitCode,
    ...(data === undefined ? {} : { data }),
    ...(commandError === undefined ? {} : { commandError }),
    errors: [
      {
        message: detail.message,
        ...(detail.suggestion === undefined ? {} : { suggestion: detail.suggestion }),
        ...(detail.code === undefined ? {} : { code: detail.code }),
        ...(commandError === undefined ? {} : { diagnostic: commandError }),
      },
    ],
  };
}
