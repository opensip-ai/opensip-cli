/**
 * signal-dedup — host-owned normalization for run envelopes.
 *
 * ADR-0011 makes SignalEnvelope the output currency, so duplicate suppression
 * belongs at the host output plane instead of inside each tool. This keeps fit,
 * graph, sim, yagni, SARIF, cloud, and JSON output on the same rule: exact
 * identity duplicates and conservative near-identity duplicates are collapsed
 * once before presentation or egress.
 */

import {
  passRate,
  type CommandResult,
  type RunPresentation,
  type SignalEnvelope,
  type UnitResult,
} from '@opensip-cli/contracts';
import { SeverityPolicy, type Signal, type SignalSeverity } from '@opensip-cli/core';

const SEVERITY_RANK: Record<SignalSeverity, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

function isEnvelopeShape(value: unknown): value is SignalEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<SignalEnvelope>;
  return (
    Array.isArray(candidate.signals) &&
    Array.isArray(candidate.units) &&
    candidate.verdict?.summary !== undefined
  );
}

function normalizedLocation(signal: Signal): {
  readonly file: string;
  readonly line: number;
  readonly column: number;
} {
  return {
    file: signal.filePath ?? signal.code?.file ?? '',
    line: signal.line ?? signal.code?.line ?? 0,
    column: signal.column ?? signal.code?.column ?? 0,
  };
}

function normalizeMessage(message: string): string {
  return message.replace(/\s+/g, ' ').trim();
}

function signalKeys(signal: Signal): readonly string[] {
  const fingerprint = signal.fingerprint?.trim();
  const loc = normalizedLocation(signal);
  const message = normalizeMessage(signal.message);
  const base = [
    signal.provider,
    signal.ruleId,
    signal.source,
    loc.file,
    String(loc.line),
    message,
  ].join('\0');

  return [
    ...(fingerprint
      ? [`fingerprint:${signal.provider}\0${signal.source}\0${signal.ruleId}\0${fingerprint}`]
      : []),
    `exact:${base}\0${String(loc.column)}`,
    `near:${base}`,
  ];
}

function strongerSignal(left: Signal, right: Signal): Signal {
  return SEVERITY_RANK[right.severity] > SEVERITY_RANK[left.severity] ? right : left;
}

function dedupeSignals(signals: readonly Signal[]): {
  readonly signals: readonly Signal[];
  readonly removed: number;
} {
  const deduped: Signal[] = [];
  const keyToIndex = new Map<string, number>();

  for (const signal of signals) {
    const keys = signalKeys(signal);
    const existingIndex = keys.map((key) => keyToIndex.get(key)).find((i) => i !== undefined);
    if (existingIndex === undefined) {
      const nextIndex = deduped.length;
      deduped.push(signal);
      for (const key of keys) keyToIndex.set(key, nextIndex);
      continue;
    }

    const current = deduped[existingIndex];
    if (current !== undefined) {
      deduped[existingIndex] = strongerSignal(current, signal);
    }
    for (const key of keys) keyToIndex.set(key, existingIndex);
  }

  return { signals: deduped, removed: signals.length - deduped.length };
}

function countSignalsBySource(signals: readonly Signal[]): Map<
  string,
  {
    count: number;
    hasError: boolean;
  }
> {
  const bySource = new Map<string, { count: number; hasError: boolean }>();
  for (const signal of signals) {
    const current = bySource.get(signal.source) ?? {
      count: 0,
      hasError: false,
    };
    bySource.set(signal.source, {
      count: current.count + 1,
      hasError: current.hasError || SeverityPolicy.isError(signal.severity),
    });
  }
  return bySource;
}

function normalizeUnits(
  units: readonly UnitResult[],
  originalSignals: readonly Signal[],
  signals: readonly Signal[],
): readonly UnitResult[] {
  const originalBySource = countSignalsBySource(originalSignals);
  const bySource = countSignalsBySource(signals);
  return units.map((unit) => {
    const facts = bySource.get(unit.slug);
    if (facts === undefined && !originalBySource.has(unit.slug)) return unit;
    return {
      ...unit,
      passed: unit.error === undefined && !(facts?.hasError ?? false),
      violationCount: facts?.count ?? 0,
    };
  });
}

function countSummary(
  units: readonly UnitResult[],
  signals: readonly Signal[],
): SignalEnvelope['verdict']['summary'] {
  let errors = 0;
  let warnings = 0;
  for (const signal of signals) {
    if (SeverityPolicy.isError(signal.severity)) errors += 1;
    else warnings += 1;
  }

  const total = units.length;
  const passed = units.filter((unit) => unit.passed).length;
  return {
    total,
    passed,
    failed: total - passed,
    errors,
    warnings,
  };
}

/**
 * Collapse duplicate signals and recompute envelope counts for presentation and
 * egress. The run verdict's pass/fail boolean is preserved: host normalization
 * does not have access to the tool's findings policy, and must not silently
 * change a tool's exit semantics while reducing noise.
 */
export function normalizeSignalEnvelope(envelope: SignalEnvelope): SignalEnvelope {
  if (!isEnvelopeShape(envelope)) return envelope;

  const deduped = dedupeSignals(envelope.signals);
  if (deduped.removed === 0) return envelope;

  const units = normalizeUnits(envelope.units, envelope.signals, deduped.signals);
  const summary = countSummary(units, deduped.signals);
  return {
    ...envelope,
    signals: deduped.signals,
    units,
    verdict: {
      ...envelope.verdict,
      score: passRate(summary),
      passed: envelope.verdict.passed,
      summary,
    },
  };
}

function isRunPresentation(result: CommandResult): result is RunPresentation {
  return (result as { readonly type?: unknown }).type === 'run-presentation';
}

export function normalizeCommandResultForRender(result: CommandResult): CommandResult {
  if (!isRunPresentation(result)) return result;
  const envelope = normalizeSignalEnvelope(result.envelope);
  return envelope === result.envelope ? result : { ...result, envelope };
}
