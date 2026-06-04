/**
 * SignalEnvelope — the universal tool-run output currency (ADR-0011).
 *
 * Every tool run yields one envelope: the flat `Signal[]` a run produced
 * (the same currency the cloud egresses via {@link SignalBatch}, ADR-0008)
 * plus run identity (`tool`, `recipe`, `runId`, `createdAt`), a `verdict`
 * header (so `--json | jq '.verdict.passed'` / `.verdict.score` work), and a
 * `units[]` sidecar (so "ran, errored, 0 signals" is expressible — a flat
 * signal list cannot carry per-unit ran/errored/timing facts).
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
import type { Signal, ToolShortId } from '@opensip-tools/core';

/**
 * Run-level verdict header. `passed` ⇔ "no `critical`/`high` signals";
 * `score` is the canonical pass rate over `summary`.
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
