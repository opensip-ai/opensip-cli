import { compareCodePoint } from '@opensip-cli/contracts';

import { toMcpFinding } from './signal-projection.js';

import type { McpBaselineDelta, McpEvidenceDegradation, McpFinding } from './result-dto.js';
import type { Signal } from '@opensip-cli/core';
import type { BaselineRow } from '@opensip-cli/datastore';

const DEFAULT_DETAIL_LIMIT = 50;

export interface CompareSignalsToBaselineInput {
  readonly current: readonly Signal[];
  readonly baselineRows: readonly BaselineRow[];
  readonly limit?: number;
  readonly includeResolved?: boolean;
}

export interface BaselineComparisonProjection {
  readonly delta: McpBaselineDelta;
  readonly addedFindings: readonly McpFinding[];
  readonly resolvedFindings?: readonly McpFinding[];
  readonly degraded?: readonly McpEvidenceDegradation[];
}

export function compareSignalsToBaseline(
  input: CompareSignalsToBaselineInput,
): BaselineComparisonProjection {
  const limit = input.limit ?? DEFAULT_DETAIL_LIMIT;
  const baseline = new Map(input.baselineRows.map((row) => [row.fingerprint, row]));
  const currentByFingerprint = new Map<string, Signal>();
  let missingFingerprint = 0;

  for (const signal of input.current) {
    const fingerprint = signal.fingerprint;
    if (fingerprint === undefined || fingerprint.length === 0) {
      missingFingerprint += 1;
      continue;
    }
    currentByFingerprint.set(fingerprint, signal);
  }

  const currentFingerprints = new Set(currentByFingerprint.keys());
  const added: Signal[] = [];
  let unchanged = 0;
  for (const [fingerprint, signal] of currentByFingerprint) {
    if (baseline.has(fingerprint)) unchanged += 1;
    else added.push(signal);
  }

  // Defence in depth: when NOT ONE current signal carries a fingerprint, the
  // comparison has no evidence at all — every baseline row would trivially look
  // resolved ("all N findings were fixed") when nothing actually changed. That
  // silently-wrong number is worse than no number, so the resolved set is
  // suppressed and the condition is surfaced as a hard degradation instead.
  const comparisonUnavailable =
    input.current.length > 0 && missingFingerprint === input.current.length;

  const resolvedRows = comparisonUnavailable
    ? []
    : input.baselineRows
        .filter((row) => !currentFingerprints.has(row.fingerprint))
        .sort((a, b) => compareCodePoint(a.fingerprint, b.fingerprint));
  const legacyResolvedRows = resolvedRows.filter((row) => row.payload === null).length;
  const degraded: McpEvidenceDegradation[] = [];
  if (comparisonUnavailable) {
    degraded.push({
      code: 'comparison-unavailable',
      message:
        `All ${String(missingFingerprint)} current signal(s) lacked a baseline fingerprint, so ` +
        'this run cannot be compared to the stored baseline. Re-run the tool to persist a ' +
        'fingerprint-stamped session; resolved counts are reported as 0 rather than guessed.',
      count: missingFingerprint,
    });
  } else if (missingFingerprint > 0) {
    degraded.push({
      code: 'missing-fingerprint',
      message: `${String(missingFingerprint)} current signal(s) lacked a baseline fingerprint.`,
      count: missingFingerprint,
    });
  }
  if (legacyResolvedRows > 0) {
    degraded.push({
      code: 'legacy-baseline-payload',
      message:
        `${String(legacyResolvedRows)} resolved baseline row(s) had no stored payload, so ` +
        'resolved finding details are incomplete.',
      count: legacyResolvedRows,
    });
  }

  return {
    delta: {
      added: added.length,
      resolved: resolvedRows.length,
      unchanged,
      missingFingerprint,
    },
    addedFindings: added.slice(0, limit).map(toMcpFinding),
    ...(input.includeResolved === true
      ? {
          resolvedFindings: resolvedRows
            .flatMap((row) => (row.payload === null ? [] : [row.payload]))
            .slice(0, limit)
            .map(toMcpFinding),
        }
      : {}),
    ...(degraded.length === 0 ? {} : { degraded }),
  };
}
