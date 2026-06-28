/**
 * @fileoverview Scan-result emission + the gate-ratchet decision (ADR-0036).
 *
 * Split from {@link ./run-loop} (the IO orchestration: resolve → exec → parse →
 * envelope) so the "what to emit + which gate branch" decision is a small,
 * directly-testable unit and the loop body stays a flat pipeline. Every effect
 * here is a documented `ToolCliContext` seam — for an INSTALLED adapter these run
 * worker-side and replay through the host (FRR for `render`/`emitEnvelope`; host
 * RPC for `saveBaseline`/`compareBaseline`/`deliverSignals`).
 */

import { resolveFailOnDegraded } from '@opensip-cli/core';

import { renderGateCompareLines, renderGateSaveLines } from './gate-render.js';
import { buildAdapterSessionPayload } from './session-payload.js';

import type { BinaryResolutionLayer } from './types.js';
import type { SignalEnvelope } from '@opensip-cli/contracts';
import type { Signal, ToolCliContext } from '@opensip-cli/core';

/** Logger `module` field for every event this module emits. */
const MODULE = 'external-tool-adapter';

/** What the host persists + dispatches after a scan (the run loop's return shape). */
export interface ScanCompletion {
  readonly envelope: SignalEnvelope;
  readonly session: {
    readonly tool: string;
    readonly cwd: string;
    readonly score: number;
    readonly passed: boolean;
    readonly payload: Record<string, unknown>;
  };
}

/** The `deliverSignals` options bag (cwd + optional egress targets). */
export interface DeliverOpts {
  readonly cwd: string;
  readonly reportTo?: string;
  readonly apiKey?: string;
}

/** Build the `deliverSignals` options bag from the parsed flags (cwd + optional egress). */
export function deliverOptions(opts: Record<string, unknown>, fallbackCwd: string): DeliverOpts {
  return {
    cwd: typeof opts.cwd === 'string' ? opts.cwd : fallbackCwd,
    ...(typeof opts.reportTo === 'string' ? { reportTo: opts.reportTo } : {}),
    ...(typeof opts.apiKey === 'string' ? { apiKey: opts.apiKey } : {}),
  };
}

/** Inputs the run loop hands {@link buildScanCompletion} to shape the session row. */
export interface ScanCompletionInput {
  readonly tool: string;
  readonly cwd: string;
  readonly envelope: SignalEnvelope;
  readonly signals: readonly Signal[];
  readonly binary: { readonly path: string; readonly layer: BinaryResolutionLayer; readonly version: string | null };
  readonly artifact: string;
  readonly durationMs: number;
}

/**
 * Shape the {@link ScanCompletion} the host persists/dispatches. The session
 * payload carries the dashboard-shaped grouped detail (`__version`/`summary`/
 * `checks[]` from {@link buildAdapterSessionPayload}) so the HTML report renders
 * the scan's findings instead of falsely "clean" — plus the operational
 * provenance the row also keeps (binary/artifact/findings/durationMs). Built from
 * the already-redacted signals, so no raw secret reaches the persisted row.
 */
export function buildScanCompletion(input: ScanCompletionInput): ScanCompletion {
  return {
    envelope: input.envelope,
    session: {
      tool: input.tool,
      cwd: input.cwd,
      score: input.envelope.verdict.score,
      passed: input.envelope.verdict.passed,
      payload: {
        ...buildAdapterSessionPayload(input.signals),
        binary: input.binary,
        artifact: input.artifact,
        findings: input.signals.length,
        durationMs: input.durationMs,
      },
    },
  };
}

/** The human (non-`--json`) one-line scan summary. */
function summaryLines(tool: string, signalCount: number, score: number, passed: boolean): string[] {
  return [
    `${tool}: ${String(signalCount)} finding(s)`,
    `verdict: ${passed ? 'PASS' : 'FAIL'} (score ${score.toFixed(2)})`,
  ];
}

/** One `adapter.scan.completed` log line, with the optional gate-mode annotations. */
function logCompleted(
  cli: ToolCliContext,
  tool: string,
  signalCount: number,
  passed: boolean,
  gate?: 'save' | 'compare',
  degraded?: boolean,
): void {
  cli.logger.info({
    evt: 'adapter.scan.completed',
    module: MODULE,
    tool,
    findings: signalCount,
    passed,
    ...(gate === undefined ? {} : { gate }),
    ...(degraded === undefined ? {} : { degraded }),
  });
}

/**
 * Emit the scan result, deliver its signals, and return the completion. Branches:
 *
 *   - `--gate-save` (ADR-0020/0035): record the baseline via the host seam, render
 *     `gate-done`, and deliver WITHOUT a runFailed override so the host derives the
 *     findings exit from the verdict.
 *   - `--gate-compare` (ADR-0035/0036): diff against the saved baseline, render the
 *     diff, and pass `degraded && failOnDegraded` as the host runFailed override
 *     (the findings verdict does NOT gate here — only NET-NEW findings fail).
 *   - normal: emit the envelope (`--json`) or a human summary, deliver without an
 *     override.
 *
 * Both gate paths still RETURN the session contribution, so a gate run persists a
 * session alongside a normal scan.
 */
export async function emitScanCompletion(
  cli: ToolCliContext,
  tool: string,
  opts: Record<string, unknown>,
  envelope: SignalEnvelope,
  signalCount: number,
  deliver: DeliverOpts,
  completion: ScanCompletion,
): Promise<ScanCompletion> {
  if (opts.gateSave === true) {
    await cli.saveBaseline(tool, envelope);
    await cli.render({ type: 'gate-done', lines: renderGateSaveLines(tool, signalCount) });
    await cli.deliverSignals(envelope, deliver);
    logCompleted(cli, tool, signalCount, envelope.verdict.passed, 'save');
    return completion;
  }
  if (opts.gateCompare === true) {
    const result = await cli.compareBaseline(tool, envelope);
    await cli.render({ type: 'gate-done', lines: renderGateCompareLines(tool, result) });
    await cli.deliverSignals(envelope, {
      ...deliver,
      runFailed: result.degraded && resolveFailOnDegraded(tool),
    });
    logCompleted(cli, tool, signalCount, envelope.verdict.passed, 'compare', result.degraded);
    return completion;
  }

  if (opts.json === true) {
    cli.emitEnvelope(envelope);
  } else {
    await cli.render({
      type: 'text-lines',
      title: `${tool} scan`,
      lines: summaryLines(tool, signalCount, envelope.verdict.score, envelope.verdict.passed),
    });
  }
  await cli.deliverSignals(envelope, deliver);
  logCompleted(cli, tool, signalCount, envelope.verdict.passed);
  return completion;
}
