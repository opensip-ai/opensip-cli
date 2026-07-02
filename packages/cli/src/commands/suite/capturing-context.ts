import { EXIT_CODES } from '@opensip-cli/contracts';

import type { RunVerdict, SignalEnvelope } from '@opensip-cli/contracts';
import type { SignalDeliveryResult, ToolCliContext } from '@opensip-cli/core';

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

export function createCapturingContext(base: ToolCliContext): StepCapture {
  // Single mutable last-write-wins exit slot — the per-step mirror of the host's
  // `outputPlane` holder. ALL exit sources for the step (the tool's `setExitCode`,
  // the `deliverSignals` findings/report mirror below, and a direct `process.exit`
  // routed in by `withProcessExitGuard`) write THIS slot, so `getExitCode()` is the
  // single source of truth for the step's verdict.
  let exitCode: number | undefined;
  let lastEnvelopeStats: StepEnvelopeStats | undefined;
  let lastEnvelope: SignalEnvelope | undefined;
  const signalDeliveries: SignalDeliveryResult[] = [];
  const context = Object.defineProperties(
    {},
    Object.getOwnPropertyDescriptors(base as object),
  ) as ToolCliContext;

  Object.defineProperties(context, {
    setExitCode: {
      value: (code: number) => {
        // OVERWRITE (last-write-wins): a later `setExitCode(SUCCESS)` — e.g. yagni's
        // `applyAdvisoryExitCode` re-affirming exit 0 after nested graph evidence
        // raised the code — must be able to LOWER the step exit, exactly as the host
        // holder does. The old append-then-`Math.max` could never lower.
        exitCode = code;
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
        const result = await base.deliverSignals(envelope, opts);
        signalDeliveries.push(result);
        lastEnvelopeStats = captureEnvelopeStats(envelope) ?? lastEnvelopeStats;
        lastEnvelope = captureEnvelope(envelope) ?? lastEnvelope;
        // Mirror the host's `deliverEnvelope` exit precedence
        // (`bootstrap/deliver-envelope.ts` → `deriveReportExitDecision`). The host
        // applies the findings/report exit through ITS OWN `outputPlane.setExitCode`,
        // bypassing this wrapper's override — so without this mirror the step's
        // verdict / report-upload exit would be invisible to the capture. Replicate
        // the SAME precedence here, last-write-wins (SET, not push), and like
        // `deliverEnvelope` only ever SET a failure code — never reset to 0 on a pass
        // (a passing, no-`--report-to` run leaves the slot untouched):
        //   - runFailed (verdict failed, or an explicit gate-compare override)
        //     DOMINATES → RUNTIME_ERROR (1);
        //   - else a `--report-to` upload failure (`reportSuccess === false`)
        //     → REPORT_FAILED (4).
        // `reportSuccess` is `undefined` on the no-`--report-to` path, so the strict
        // `=== false` is exact and never fires there.
        const runFailed =
          opts.runFailed ??
          (envelope as Partial<SignalEnvelope> | undefined)?.verdict?.passed === false;
        if (runFailed) {
          exitCode = EXIT_CODES.RUNTIME_ERROR;
        } else if (result.reportSuccess === false) {
          exitCode = EXIT_CODES.REPORT_FAILED;
        }
        return result;
      },
    },
    emitEnvelope: {
      value: (envelope: Parameters<ToolCliContext['emitEnvelope']>[0]) => {
        lastEnvelopeStats = captureEnvelopeStats(envelope) ?? lastEnvelopeStats;
        lastEnvelope = captureEnvelope(envelope) ?? lastEnvelope;
        base.emitEnvelope(envelope);
      },
    },
  });

  return {
    getExitCode: () => exitCode,
    getEnvelopeStats: () => lastEnvelopeStats,
    getEnvelope: () => lastEnvelope,
    signalDeliveries,
    context,
  };
}
