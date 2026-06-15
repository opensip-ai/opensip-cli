/**
 * Signal type — compatible with OpenSIP's signal format.
 * Used by the check framework internally. Converted to Finding for output.
 */

export type SignalSeverity = 'critical' | 'high' | 'medium' | 'low';
/** Canonical category labels a Signal may declare (open at the plugin layer). */
export type SignalCategory =
  | 'security'
  | 'quality'
  | 'architecture'
  | 'testing'
  | 'resilience'
  | 'documentation'
  | 'warning'
  | 'performance'
  | 'error';

/** A finding produced by any analyzer — file location, severity, message, and metadata. */
export interface Signal {
  readonly id: string;
  readonly source: string;
  readonly provider: string;
  readonly severity: SignalSeverity;
  // eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents -- documents the canonical set while leaving the field open for plugin-defined categories
  readonly category: SignalCategory | string;
  readonly ruleId: string;
  readonly message: string;
  readonly suggestion?: string;
  readonly filePath: string;
  readonly line?: number;
  readonly column?: number;
  readonly code?: { file?: string; line?: number; column?: number };
  readonly fixAction?: string;
  readonly fixConfidence?: number;
  readonly metadata: Record<string, unknown>;
  readonly strength?: number;
  /**
   * Stable identity for the host baseline/ratchet plane (ADR-0036). Stamped at
   * signal-creation / envelope-construction time by the tool's
   * `FingerprintStrategy` (host default when unset), via `stampFingerprints`,
   * BEFORE the envelope reaches a host seam. Opaque to the plane; the plane never
   * re-fingerprints or re-derives it downstream (the host seams only read it).
   * Optional: a freshly-`createSignal`'d signal has none until stamped.
   */
  readonly fingerprint?: string;
  readonly createdAt: string;
}

/** Input shape for {@link createSignal} — required fields plus optional fix hint. */
export interface CreateSignalInput {
  source: string;
  provider?: string;
  severity: SignalSeverity;
  // eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents -- documents the canonical set while leaving the field open for plugin-defined categories
  category?: SignalCategory | string;
  ruleId: string;
  message: string;
  suggestion?: string;
  code?: { file?: string; line?: number; column?: number };
  fix?: FixHint;
  metadata?: Record<string, unknown>;
}

/** Optional remediation hint attached to a Signal — action label and confidence. */
export interface FixHint {
  readonly action?: string;
  readonly confidence?: number;
  readonly description?: string;
}

/**
 * True when a severity is on the "error" rung (`critical` or `high`), as
 * opposed to the "warning" rung (`medium`/`low`). This is the single canonical
 * predicate behind the run verdict (`passed ⇔ no error-rung signals`), the
 * terminal table's error/warning split, the gate's severity, the SARIF
 * `error` level, and the dashboard's 2-level bucketing — shared so all
 * consumers agree (it lives in core alongside {@link Signal}).
 */
export function isErrorSeverity(severity: SignalSeverity): boolean {
  return severity === 'critical' || severity === 'high';
}

/** True when a {@link Signal} is on the error rung. See {@link isErrorSeverity}. */
export function isErrorSignal(signal: Signal): boolean {
  return isErrorSeverity(signal.severity);
}

import { randomUUID } from 'node:crypto';

/** Builds a {@link Signal} with default provider, generated id, and ISO timestamp. */
export function createSignal(input: CreateSignalInput): Signal {
  return {
    id: `sig_${randomUUID().slice(0, 12)}`,
    source: input.source,
    provider: input.provider ?? 'opensip-cli',
    severity: input.severity,
    category: input.category ?? 'quality',
    ruleId: input.ruleId,
    message: input.message,
    suggestion: input.suggestion,
    filePath: input.code?.file ?? '',
    line: input.code?.line,
    column: input.code?.column,
    code: input.code,
    fixAction: input.fix?.action,
    fixConfidence: input.fix?.confidence,
    metadata: input.metadata ?? {},
    createdAt: new Date().toISOString(),
  };
}
