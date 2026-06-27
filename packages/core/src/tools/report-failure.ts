/**
 * ReportFailureDetail — the public tool-facing input for handler-time command
 * failures (Plan 06 / ADR-0077). Tools declare intent; the CLI host fans out to
 * structured log, customer surface, exit code, and diagnostics bus.
 *
 * Defined in core (beside {@link ToolCliContext}) so it can name core
 * {@link ToolError} and {@link CliDiagnostic} without importing contracts.
 */

import type { CliDiagnostic } from '../lib/cli-diagnostic.js';

/** Structured log metadata optionally supplied with a command failure report. */
export interface ReportFailureLogDetail {
  readonly level?: 'warn' | 'error';
  readonly evt: string;
  readonly data?: Readonly<Record<string, unknown>>;
}

/**
 * Passed to {@link ToolCliContext.reportFailure}. The host resolves message,
 * exit code, and code from ToolError-compatible errors when omitted, then
 * performs effectful fan-out (log, render / emitError / diagnostic stderr,
 * exit code). Do not throw values that contain secrets; the derived
 * customer-facing message is bounded but still visible.
 */
export interface ReportFailureDetail {
  /** Customer-facing headline (required unless `error` supplies message). */
  readonly message?: string;
  /** Actionable next step for humans / JSON suggestion field. */
  readonly suggestion?: string;
  /** Machine branch code (ErrorDetail.code / ToolError.code). */
  readonly code?: string;
  /** Explicit exit code; omitted when `error` is a ToolError (host maps). */
  readonly exitCode?: number;
  /** Caught throwable — host derives message/exitCode/code when omitted. */
  readonly error?: unknown;
  /** ADR-0060 structured diagnostic for setup-class failures surfaced mid-handler. */
  readonly diagnostic?: CliDiagnostic;
  /** Whether this command invocation requested JSON output. */
  readonly jsonRequested?: boolean;
  /**
   * Optional structured log line written BEFORE customer render.
   * When omitted, host still logs a default `tool.command.failed` at warn
   * with message + code + exitCode.
   */
  readonly log?: ReportFailureLogDetail;
}

/**
 * Wire-safe resolved failure detail (no live Error instances). Used by the CLI
 * worker replay protocol after {@link resolveReportFailure} runs worker-side.
 */
export interface ResolvedReportFailure {
  readonly message: string;
  readonly exitCode: number;
  readonly suggestion?: string;
  readonly code?: string;
  readonly diagnostic?: CliDiagnostic;
  readonly jsonRequested?: boolean;
  readonly log?: ReportFailureLogDetail;
}
