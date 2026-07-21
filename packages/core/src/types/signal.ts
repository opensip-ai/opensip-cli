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
  /**
   * 1-based line when present (ADR-0179). Omitted for whole-file findings.
   * Only finite integers ≥ 1 are recorded by {@link createSignal}.
   */
  readonly line?: number;
  /**
   * 1-based column when present (ADR-0179). Omitted for whole-file / whole-line
   * findings. Only finite integers ≥ 1 are recorded by {@link createSignal};
   * emitters must convert from native 0-based indices before construction.
   */
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
  /** Optional structured repair guidance (ADR-0086). */
  readonly repair?: SignalRepair;
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
  repair?: SignalRepair;
}

/** Optional remediation hint attached to a Signal — action label and confidence. */
export interface FixHint {
  readonly action?: string;
  readonly confidence?: number;
  readonly description?: string;
}

/** Scalar action target metadata safe to persist in session payloads. */
export type SignalRepairActionTarget = Readonly<Record<string, string | number | boolean>>;

/** Verification guidance agents should run after an action is applied. */
export interface SignalRepairVerification {
  readonly commands: readonly string[];
  readonly notes?: readonly string[];
}

/** One deterministic action a repair-aware consumer may preview or apply. */
export interface SignalRepairAction {
  readonly id: string;
  /** Open string; first-party values are documented in the public JSON schema. */
  readonly kind: string;
  readonly title: string;
  readonly description?: string;
  readonly autofixable: boolean;
  readonly confidence?: number;
  readonly patchHint?: {
    readonly kind: 'text' | 'structured';
    readonly summary: string;
    readonly target?: string;
  };
  readonly verification?: SignalRepairVerification;
  readonly target?: SignalRepairActionTarget;
}

/** Structured repair contract for AI agents (ADR-0086, spec §5.5). */
export interface SignalRepair {
  readonly repairKind?:
    'add-test' | 'split-function' | 'extract-module' | 'fix-import' | 'manual' | 'unknown';
  readonly autofixable?: boolean;
  readonly suggestedCommand?: string;
  readonly docsRef?: string;
  readonly confidence?: number;
  readonly patchHint?: {
    readonly kind: 'text' | 'structured';
    readonly summary: string;
    readonly target?: string;
  };
  /** Optional concrete actions for deterministic preview/apply consumers. */
  readonly actions?: readonly SignalRepairAction[];
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

function repairKindFromAction(action: string | undefined): SignalRepair['repairKind'] {
  if (action === 'add-test') return 'add-test';
  if (action === 'fix-import') return 'fix-import';
  if (action === 'split-function') return 'split-function';
  if (action === 'extract-module') return 'extract-module';
  return 'manual';
}

function repairFromFix(fix: FixHint | undefined): SignalRepair | undefined {
  if (fix === undefined) return undefined;
  const summary = fix.description ?? (fix.action ? `Apply ${fix.action} remediation` : undefined);
  return {
    repairKind: repairKindFromAction(fix.action),
    autofixable: false,
    ...(fix.confidence === undefined ? {} : { confidence: fix.confidence }),
    ...(summary === undefined ? {} : { patchHint: { kind: 'text', summary } }),
  };
}

/**
 * Admit a 1-based line/column coordinate for {@link Signal} (ADR-0179).
 * Finite integers ≥ 1 are kept; missing, non-finite, and `< 1` values are
 * omitted (whole-file / whole-line). This is the sole construction gate for
 * coordinate base — SARIF and other emitters must not re-guess 0-vs-1.
 */
export function toOneBasedCoordinate(value: number | undefined): number | undefined {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 1
    ? value
    : undefined;
}

/** Normalize optional `code` so line/column honor the 1-based Signal contract. */
function normalizeSignalCode(
  code: CreateSignalInput['code'],
): CreateSignalInput['code'] | undefined {
  if (code === undefined) return undefined;
  const line = toOneBasedCoordinate(code.line);
  const column = toOneBasedCoordinate(code.column);
  return {
    ...(code.file === undefined ? {} : { file: code.file }),
    ...(line === undefined ? {} : { line }),
    ...(column === undefined ? {} : { column }),
  };
}

/** Builds a {@link Signal} with default provider, generated id, and ISO timestamp. */
export function createSignal(input: CreateSignalInput): Signal {
  const repair = input.repair ?? repairFromFix(input.fix);
  const code = normalizeSignalCode(input.code);
  return {
    id: `sig_${randomUUID().slice(0, 12)}`,
    source: input.source,
    provider: input.provider ?? 'opensip-cli',
    severity: input.severity,
    category: input.category ?? 'quality',
    ruleId: input.ruleId,
    message: input.message,
    suggestion: input.suggestion,
    filePath: code?.file ?? '',
    line: code?.line,
    column: code?.column,
    code,
    fixAction: input.fix?.action,
    fixConfidence: input.fix?.confidence,
    metadata: input.metadata ?? {},
    ...(repair === undefined ? {} : { repair }),
    createdAt: new Date().toISOString(),
  };
}
