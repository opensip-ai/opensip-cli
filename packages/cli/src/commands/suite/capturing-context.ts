import {
  currentLogger,
  currentScope,
  type ReportFailureDetail,
  type ResolvedReportFailure,
  type SignalDeliveryResult,
  type ToolCliContext,
} from '@opensip-cli/core';

import { createEgressPlane, type EgressPlane } from '../../bootstrap/io-plane.js';
import {
  createReportFailure,
  resolveReportFailure,
  truncateDerivedMessage,
} from '../../bootstrap/report-failure.js';

import type { RunVerdict, SignalEnvelope } from '@opensip-cli/contracts';

export interface StepEnvelopeStats {
  readonly verdict: RunVerdict;
  readonly findings: number;
}

export interface StepCapture {
  /**
   * The step's captured exit code — a SINGLE last-write-wins slot that mirrors the
   * host's one exit holder (`bootstrap/output-plane.ts`: `let exitCode;
   * setExitCode overwrites`), NOT an append-only log reduced by `Math.max`. The
   * former array+max model diverged from the host holder in two ways (a
   * `--report-to` failure exit 4 was never captured; an advisory lower-to-SUCCESS
   * could not undo an earlier raise) — both are one defect: append+max ≠
   * last-write-wins. `undefined` when the step neither called `setExitCode` nor
   * delivered a failing / report-failed envelope (the orchestrator then defaults
   * to `EXIT_CODES.SUCCESS`).
   */
  readonly getExitCode: () => number | undefined;
  /**
   * Last emitted envelope stats for the step. `undefined` means the step did not
   * emit an envelope, which is distinct from an envelope with zero findings.
   */
  readonly getEnvelopeStats: () => StepEnvelopeStats | undefined;
  /**
   * Last emitted full envelope for host-owned aggregate projections. The public
   * suite step summary stays count-only; the orchestrator consumes this internal
   * value before returning the final command result.
   */
  readonly getEnvelope: () => SignalEnvelope | undefined;
  readonly getReportedFailure: () => ResolvedReportFailure | undefined;
  readonly signalDeliveries: readonly SignalDeliveryResult[];
  readonly context: ToolCliContext;
}

function captureEnvelope(envelope: unknown): SignalEnvelope | undefined {
  const maybeEnvelope = envelope as Partial<SignalEnvelope> | undefined;
  if (maybeEnvelope?.schemaVersion !== 2) return undefined;
  if (typeof maybeEnvelope.tool !== 'string') return undefined;
  if (typeof maybeEnvelope.runId !== 'string') return undefined;
  if (maybeEnvelope.verdict?.summary === undefined) return undefined;
  if (!Array.isArray(maybeEnvelope.signals)) return undefined;
  return maybeEnvelope as SignalEnvelope;
}

function captureEnvelopeStats(envelope: unknown): StepEnvelopeStats | undefined {
  const maybeEnvelope = envelope as Partial<SignalEnvelope> | undefined;
  const verdict = maybeEnvelope?.verdict;
  if (verdict?.summary === undefined) return undefined;
  const signals = maybeEnvelope?.signals;
  return {
    verdict,
    findings: Array.isArray(signals) ? signals.length : 0,
  };
}

export function createCapturingContext(
  base: ToolCliContext,
  deps: { readonly egress?: (setExitCode: (code: number) => void) => EgressPlane } = {},
): StepCapture {
  // Single mutable last-write-wins exit slot — the per-step mirror of the host's
  // `outputPlane` holder. ALL exit sources for the step write THIS slot, so
  // `getExitCode()` is the single source of truth for the step's verdict: the
  // tool's `setExitCode`, the `deliverSignals` findings/report mirror below, a
  // direct `process.exit` routed in by `withProcessExitGuard`, `reportFailure`,
  // and the public `emitError` seam (which the host implements as an exit source
  // + a `CommandOutcome` write — the ADR-0054 worker replay path reaches it via
  // `ctx.emitError(result.error)`, so it must be captured, not left to the host
  // holder or it would false-green the step and emit a stray outcome mid-suite).
  let exitCode: number | undefined;
  let lastEnvelopeStats: StepEnvelopeStats | undefined;
  let lastEnvelope: SignalEnvelope | undefined;
  let reportedFailure: ResolvedReportFailure | undefined;
  const signalDeliveries: SignalDeliveryResult[] = [];
  const writeExit = (code: number): void => {
    exitCode = code;
  };
  // Route an error detail into the slot + reported-failure record, emitting
  // nothing to the host (the suite renders one CommandOutcome from the
  // aggregate). Shared by `createReportFailure`'s emit seam and the context's
  // own `emitError` override so both stay in lockstep.
  const captureErrorDetail = (detail: Parameters<ToolCliContext['emitError']>[0]): void => {
    writeExit(detail.exitCode);
    reportedFailure = {
      message: truncateDerivedMessage(detail.message),
      exitCode: detail.exitCode,
      ...(detail.suggestion === undefined ? {} : { suggestion: detail.suggestion }),
      ...(detail.code === undefined ? {} : { code: detail.code }),
      ...(detail.diagnostic === undefined ? {} : { diagnostic: detail.diagnostic }),
    };
  };
  const egress =
    deps.egress?.(writeExit) ??
    createEgressPlane({
      setExitCode: writeExit,
      logger: currentLogger(),
    });
  const reportFailure = createReportFailure({
    getLogger: () => currentLogger(),
    setExitCode: writeExit,
    render: () => Promise.resolve(),
    emitError: captureErrorDetail,
    getDiagnostics: () => currentScope()?.diagnostics,
  });
  const context = Object.defineProperties(
    {},
    Object.getOwnPropertyDescriptors(base as object),
  ) as ToolCliContext;

  Object.defineProperties(context, {
    render: {
      // The parent suite owns the only visible result. Embedded steps may call
      // their documented renderer, but cannot emit a second terminal body.
      value: () => Promise.resolve(),
    },
    emitJson: {
      value: () => {
        // Parent suite JSON is emitted once after all steps complete.
      },
    },
    emitRaw: {
      value: () => {
        // Raw step documents remain private to embedded execution.
      },
    },
    setExitCode: {
      value: (code: number) => {
        // OVERWRITE (last-write-wins): a later `setExitCode(SUCCESS)` — e.g. yagni's
        // `applyAdvisoryExitCode` re-affirming exit 0 after nested graph evidence
        // raised the code — must be able to LOWER the step exit, exactly as the host
        // holder does. The old append-then-`Math.max` could never lower.
        writeExit(code);
      },
    },
    getExitCode: {
      // Read the slot (NOT the inherited host holder). The override above isolates
      // the step's writes into the slot, so reads must come from the slot too —
      // otherwise a tool that reads its own exit mid-run (yagni's advisory check
      // inspects `cli.getExitCode()` for a prior REPORT_FAILED, or a nested
      // `setExitCode` from graph evidence) would see a stale cross-step host value
      // and split-brain against where its own writes landed.
      value: () => exitCode,
    },
    deliverSignals: {
      value: async (
        envelope: Parameters<ToolCliContext['deliverSignals']>[0],
        opts: Parameters<ToolCliContext['deliverSignals']>[1],
      ) => {
        const result = await egress.deliverSignals(envelope, opts);
        signalDeliveries.push(result);
        lastEnvelopeStats = captureEnvelopeStats(envelope) ?? lastEnvelopeStats;
        lastEnvelope = captureEnvelope(envelope) ?? lastEnvelope;
        return result;
      },
    },
    reportFailure: {
      value: async (detail: ReportFailureDetail) => {
        const resolved = resolveReportFailure(detail);
        const boundedMessage = truncateDerivedMessage(resolved.message);
        reportedFailure = { ...resolved, message: boundedMessage };
        await reportFailure({ ...detail, message: boundedMessage });
      },
    },
    emitEnvelope: {
      value: (envelope: Parameters<ToolCliContext['emitEnvelope']>[0]) => {
        lastEnvelopeStats = captureEnvelopeStats(envelope) ?? lastEnvelopeStats;
        lastEnvelope = captureEnvelope(envelope) ?? lastEnvelope;
      },
    },
    // Isolate the public error seam: an external (ADR-0054 worker) step whose
    // replay calls `ctx.emitError(result.error)` must land its exit in the slot,
    // not the host holder — and must NOT print a second CommandOutcome mid-suite.
    emitError: {
      value: (detail: Parameters<ToolCliContext['emitError']>[0]) => {
        captureErrorDetail(detail);
      },
    },
  });

  return {
    getExitCode: () => exitCode,
    getEnvelopeStats: () => lastEnvelopeStats,
    getEnvelope: () => lastEnvelope,
    getReportedFailure: () => reportedFailure,
    signalDeliveries,
    context,
  };
}
