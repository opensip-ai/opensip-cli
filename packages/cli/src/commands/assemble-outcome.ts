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
 * No stdout here — the builders only read the current scope's diagnostics plane.
 * {@link renderOutcome} (the sibling) is the one place an outcome reaches a stream.
 */

import {
  getErrorSuggestionFromMessage,
  mapExitClassToExitCode,
  type CliDiagnostic,
  type CommandOutcome,
  type ErrorDetail,
  type ErrorResult,
  type SignalEnvelope,
  type WarningDetail,
} from '@opensip-cli/contracts';
import {
  currentScope,
  mergeBootstrapIntoRunDiagnostics,
  normalizeFailure,
  toMachineFailureProjection,
} from '@opensip-cli/core';

/**
 * Attach the authoritative outcome diagnostics snapshot (north-star §5.10,
 * ADR-0176) to a freshly built outcome. Dual-reads the scope lifecycle
 * {@link DiagnosticsBus} and the typed {@link BootstrapDiagnosticsCollector},
 * projecting bootstrap `CliDiagnostic`s as lifecycle events with
 * `data.origin: 'bootstrap'`. Omitted when no scope is bound (isolated unit
 * tests).
 */
function withDiagnostics(outcome: CommandOutcome): CommandOutcome {
  const scope = currentScope();
  if (scope?.diagnostics === undefined) return outcome;
  const diagnostics = mergeBootstrapIntoRunDiagnostics(
    scope.diagnostics.snapshot(),
    scope.bootstrapDiagnostics.list(),
  );
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
 *
 * `warnings` are non-fatal run notices (e.g. graph's partial-coverage
 * parse-failure count) stamped onto `CommandOutcome.warnings`; they never
 * change `status` or `exitCode`.
 */
export function outcomeFromEnvelope(
  envelope: SignalEnvelope,
  exitCode: number,
  warnings?: readonly WarningDetail[],
): CommandOutcome {
  return withDiagnostics({
    kind: kindFromEnvelope(envelope),
    status: 'ok',
    exitCode,
    envelope,
    ...(warnings === undefined || warnings.length === 0 ? {} : { warnings }),
  });
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
  return withDiagnostics({
    kind: kindFromResult(value),
    status: 'ok',
    exitCode,
    data: value,
  });
}

/**
 * Build a `status:'error'` outcome from a thrown error — the host's error
 * stamper. Every throwable is normalized through the total failure envelope;
 * definition exit class drives the numeric code and the versioned machine
 * projection rides with the error detail. The actionable `suggestion` comes from the shared
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
  const envelope = normalizeFailure(error);
  return outcomeFromFailureEnvelope(envelope, opts);
}

/** Build an error outcome from a failure already normalized by the host boundary. */
export function outcomeFromFailureEnvelope(
  envelope: ReturnType<typeof normalizeFailure>,
  opts: { readonly kind?: string } = {},
): CommandOutcome {
  const failure = toMachineFailureProjection(envelope);
  const message = typeof failure.message === 'string' ? failure.message : 'The operation failed.';
  const suggestion =
    envelope.known === 'known'
      ? envelope.operatorAction
      : (getErrorSuggestionFromMessage(envelope.message)?.action ?? envelope.operatorAction);
  const detail: ErrorDetail = {
    message,
    ...(suggestion ? { suggestion } : {}),
    code: envelope.code,
    failure,
  };
  const exitCode = mapExitClassToExitCode(envelope.definition.exitClass);
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
  readonly failure?: Readonly<Record<string, unknown>>;
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
        ...(opts.failure === undefined ? {} : { failure: opts.failure }),
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
    readonly failure?: Readonly<Record<string, unknown>>;
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
        ...(detail.failure === undefined ? {} : { failure: detail.failure }),
        ...(commandError === undefined ? {} : { diagnostic: commandError }),
      },
    ],
  };
}
