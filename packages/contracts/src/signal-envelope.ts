/**
 * SignalEnvelope — the universal tool-run output currency (ADR-0011).
 *
 * Every tool run yields one envelope: the flat `Signal[]` a run produced
 * (the same currency the cloud egresses via {@link SignalBatch}, ADR-0008)
 * plus run identity (`tool`, `recipe`, `runId`, `createdAt`), a `verdict`
 * header, and a `units[]` sidecar (so "ran, errored, 0 signals" is expressible
 * — a flat signal list cannot carry per-unit ran/errored/timing facts). On the
 * CLI wire this envelope rides under `.envelope` of a `CommandOutcome`
 * (ADR-0024), so a `--json` consumer reads `jq '.envelope.verdict.passed'` /
 * `.envelope.verdict.score`.
 *
 * This is intentionally close to {@link SignalBatch} (the cloud egress shape):
 * the cloud sink ships the signals as-is, adding `repo` identity and dropping
 * `verdict`/`units`. It lives in `contracts` — the tool↔runner contract layer —
 * because it is the `CommandResult` payload every tool returns and the
 * composition root consumes.
 *
 * `schemaVersion` is the output-contract version, independent of any package
 * version. It is `2`, succeeding the implicit `CliOutput` "1.0" husk this
 * envelope replaces.
 */
import {
  defaultFingerprintStrategy,
  policyPasses,
  SeverityPolicy,
  stampFingerprints,
} from '@opensip-tools/core';

import { passRate } from './score.js';

import type { FingerprintStrategy, Signal, ToolShortId, VerdictPolicy } from '@opensip-tools/core';

/**
 * Run-level verdict header. `passed` ⇔ "no `critical`/`high` signals";
 * `score` is the canonical {@link passRate} over `summary`.
 */
export interface RunVerdict {
  readonly score: number;
  readonly passed: boolean;
  readonly summary: {
    readonly total: number;
    readonly passed: number;
    readonly failed: number;
    readonly errors: number;
    readonly warnings: number;
  };
}

/**
 * Per-unit fact sidecar. A "unit" is the neutral umbrella over a fit check, a
 * graph rule, and a sim scenario (ADR-0011). Carries ONLY what a flat
 * `Signal[]` cannot express: that a unit ran, whether it errored, and timing.
 * `passed` ⇔ "that unit emitted no `critical`/`high` signals".
 */
export interface UnitResult {
  readonly slug: string;
  readonly passed: boolean;
  readonly violationCount?: number;
  readonly durationMs: number;
  readonly error?: string;
  /**
   * Files the unit validated/scanned this run (fitness's "Validated" column).
   * A per-unit fact a flat `Signal[]` cannot express — a check that scanned
   * 450 files and emitted 0 signals still has `filesValidated: 450`. Optional:
   * graph rules / sim scenarios do not scan files and omit it (the terminal
   * table renders the column blank for those tools). `itemType` names the
   * scanned noun (`files` / `packages` / …) for the column label.
   */
  readonly filesValidated?: number;
  readonly itemType?: string;
  /**
   * Findings suppressed by an inline `@fitness-ignore` directive this run
   * (fitness's "Ignores" column). Like {@link filesValidated}, a per-unit fact
   * not recoverable from the (post-suppression) signal list; optional and
   * omitted by tools without a suppression mechanism.
   */
  readonly ignoredCount?: number;
}

/** The one tool-run output envelope. The `CommandResult` payload every tool returns. */
export interface SignalEnvelope {
  readonly schemaVersion: 2;
  readonly tool: ToolShortId;
  readonly recipe?: string;
  readonly runId: string;
  readonly createdAt: string;
  readonly verdict: RunVerdict;
  readonly units: readonly UnitResult[];
  readonly signals: readonly Signal[];
  /** Graph-only edge-fidelity marker, carried over from CliOutput.resolutionMode. */
  readonly resolutionMode?: 'exact' | 'fast';
}

/**
 * Input to {@link buildSignalEnvelope}. `signals` are already the wire
 * currency; `units` carry the per-unit ran/errored/timing facts. `runId` and
 * `createdAt` are supplied by the caller (formatter-purity contract: no
 * `Date.now()`/`randomUUID` in this layer, so tests stay deterministic).
 */
export interface BuildEnvelopeInput {
  readonly tool: ToolShortId;
  readonly recipe?: string;
  readonly runId: string;
  readonly createdAt: string;
  readonly units: readonly UnitResult[];
  readonly signals: readonly Signal[];
  readonly resolutionMode?: 'exact' | 'fast';
  /**
   * The tool's resolved findings policy (ADR-0035). `verdict.passed` is computed
   * from `(errors, warnings)` against this — replacing the old `errors === 0`.
   */
  readonly policy: VerdictPolicy;
  /**
   * `true` when the run faulted OUTSIDE its units — e.g. fit's plugin-load
   * errors, which occur before any unit exists. Unit-level faults are derived
   * from `UnitResult.error` and need not be passed here. A faulted run always
   * FAILs, independent of the findings policy (a crash ≠ "0 errors found").
   */
  readonly runFaulted: boolean;
  /**
   * The tool's baseline-identity strategy (ADR-0036). {@link buildSignalEnvelope}
   * stamps `Signal.fingerprint` with it at construction, so every envelope
   * reaches the host seams (gate save/compare, cloud, SARIF) already stamped —
   * the "tool forgot to stamp" failure class cannot occur for an envelope built
   * here. Omitted ⇒ {@link defaultFingerprintStrategy} (`ruleId|filePath|line|col`),
   * which is exactly the documented inheritance for a tool that declares no
   * `Tool.fingerprintStrategy`. Stamping is idempotent: a signal that already
   * carries a non-empty `fingerprint` is preserved byte-for-byte, so a tool may
   * still stamp earlier (e.g. at `createSignal`) without double-hashing.
   */
  readonly fingerprintStrategy?: FingerprintStrategy;
}

/**
 * Assemble a {@link SignalEnvelope} from a run's units + signals.
 *
 * Centralises the verdict/summary computation so all three tools agree on
 * "`passed` ⇔ no critical/high" and the score definition. Pure: no IO, no
 * clock, no id generation — `runId`/`createdAt` arrive on the input.
 *
 * - `summary.total/passed/failed` come from `units` (units are what "ran").
 * - `summary.errors/warnings` come from `signals` (critical|high → error,
 *   else warning).
 * - `score = passRate(summary)`.
 * - `verdict.passed` (ADR-0035) ⇔ the run did not fault, no unit errored, AND
 *   the error/warning counts pass the tool's findings `policy`. This is the
 *   single verdict that drives both the exit code and the headline.
 * - Every signal is fingerprint-stamped (ADR-0036) with
 *   `input.fingerprintStrategy` (host default when omitted; idempotent for
 *   pre-stamped signals), so the built envelope is gate-ready by construction.
 */
export function buildSignalEnvelope(input: BuildEnvelopeInput): SignalEnvelope {
  const total = input.units.length;
  const passed = input.units.filter((u) => u.passed).length;
  const failed = total - passed;

  // ADR-0036: fingerprints are an envelope-construction concern. Stamping here
  // (tool strategy, host default when none) guarantees every built envelope is
  // gate-ready, instead of trusting each tool to remember a post-hoc stamp that
  // would otherwise only fail at the first `--gate-save`.
  const signals = stampFingerprints(
    input.signals,
    input.fingerprintStrategy ?? defaultFingerprintStrategy,
  );

  let errors = 0;
  let warnings = 0;
  for (const signal of signals) {
    // The gate's error/warning split is the central policy predicate (§5.9), one
    // source of truth shared with the verdict / terminal table / SARIF level.
    if (SeverityPolicy.isError(signal.severity)) errors += 1;
    else warnings += 1;
  }

  const summary = { total, passed, failed, errors, warnings };

  // A unit that errored (a check that threw / timed out) is a fault, not a
  // finding — it FAILs the run regardless of the findings policy. Pre-unit
  // faults (e.g. fit plugin-load) arrive on `runFaulted` since no unit exists.
  const unitFaulted = input.units.some((u) => u.error !== undefined);

  const verdict: RunVerdict = {
    score: passRate(summary),
    passed: !input.runFaulted && !unitFaulted && policyPasses({ errors, warnings }, input.policy),
    summary,
  };

  return {
    schemaVersion: 2,
    tool: input.tool,
    recipe: input.recipe,
    runId: input.runId,
    createdAt: input.createdAt,
    verdict,
    units: input.units,
    signals,
    resolutionMode: input.resolutionMode,
  };
}
