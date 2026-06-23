import type { SkippedDetector } from '../detectors/types.js';
import type {
  YagniConfidence,
  YagniEstimateKind,
  YagniFindingMetadata,
  YagniRunSummary,
} from '../types/yagni-metadata.js';
import type { Signal } from '@opensip-cli/core';

const CONFIDENCE_RANK: Record<YagniConfidence, number> = {
  high: 3,
  medium: 2,
  low: 1,
};

const ESTIMATE_KIND_RANK: Record<YagniEstimateKind, number> = {
  exact: 3,
  'lower-bound': 2,
  heuristic: 1,
};

const MIN_CONFIDENCE_RANK: Record<YagniConfidence, number> = {
  low: 1,
  medium: 2,
  high: 3,
};

export function readYagniMetadata(signal: Signal): YagniFindingMetadata | undefined {
  const raw = signal.metadata.yagni;
  if (typeof raw !== 'object' || raw === null) return undefined;
  return raw as YagniFindingMetadata;
}

/** Keep findings at or above the configured minimum confidence level. */
export function filterByMinConfidence(
  signals: readonly Signal[],
  minConfidence: YagniConfidence,
): Signal[] {
  const floor = MIN_CONFIDENCE_RANK[minConfidence];
  return signals.filter((signal) => {
    const meta = readYagniMetadata(signal);
    if (meta === undefined) return true;
    return CONFIDENCE_RANK[meta.confidence] >= floor;
  });
}

export function filterByReductionCategories(
  signals: readonly Signal[],
  categories: readonly string[],
): Signal[] {
  if (categories.length === 0) return [...signals];
  const allowed = new Set(categories);
  return signals.filter((signal) => {
    const meta = readYagniMetadata(signal);
    if (meta === undefined) return true;
    return allowed.has(meta.reductionCategory);
  });
}

function locationKey(signal: Signal): string {
  const line = signal.line ?? 0;
  const col = signal.column ?? 0;
  return `${signal.filePath}:${String(line)}:${String(col)}`;
}

/** Stable sort: confidence DESC → estimateKind → netEstimate DESC → detector → location. */
export function sortYagniSignals(signals: readonly Signal[]): Signal[] {
  return [...signals].sort((a, b) => {
    const ma = readYagniMetadata(a);
    const mb = readYagniMetadata(b);
    const confA = ma ? CONFIDENCE_RANK[ma.confidence] : 0;
    const confB = mb ? CONFIDENCE_RANK[mb.confidence] : 0;
    if (confA !== confB) return confB - confA;

    const kindA = ma?.locDelta ? ESTIMATE_KIND_RANK[ma.locDelta.estimateKind] : 0;
    const kindB = mb?.locDelta ? ESTIMATE_KIND_RANK[mb.locDelta.estimateKind] : 0;
    if (kindA !== kindB) return kindB - kindA;

    const netA = ma?.locDelta?.netEstimate ?? 0;
    const netB = mb?.locDelta?.netEstimate ?? 0;
    if (netA !== netB) return netB - netA;

    const detA = ma?.detector ?? '';
    const detB = mb?.detector ?? '';
    if (detA !== detB) return detA.localeCompare(detB);

    return locationKey(a).localeCompare(locationKey(b));
  });
}

export function buildYagniRunSummary(
  signals: readonly Signal[],
  graphMode: string,
  skippedDetectors: readonly SkippedDetector[],
): YagniRunSummary {
  let high = 0;
  let medium = 0;
  let low = 0;
  let estimatedTotalLocReduction = 0;

  for (const signal of signals) {
    const meta = readYagniMetadata(signal);
    if (meta === undefined) continue;
    if (meta.confidence === 'high') high += 1;
    else if (meta.confidence === 'medium') medium += 1;
    else low += 1;
    if (meta.locDelta !== undefined) {
      estimatedTotalLocReduction += meta.locDelta.netEstimate;
    }
  }

  return {
    totalCandidates: signals.length,
    byConfidence: { high, medium, low },
    estimatedTotalLocReduction,
    graphMode,
    skippedDetectors: skippedDetectors.map((s) => ({
      slug: s.slug,
      reason: s.reason,
      ...(s.detail === undefined ? {} : { detail: s.detail }),
    })),
  };
}

export function severityForConfidence(confidence: YagniConfidence): 'low' | 'medium' {
  return confidence === 'high' ? 'medium' : 'low';
}
