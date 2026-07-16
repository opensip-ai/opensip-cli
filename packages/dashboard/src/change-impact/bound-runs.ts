import { createHash } from 'node:crypto';

import { scriptContextJsonBytes } from '../script-context-json.js';

import type { BoundedChangeImpactRuns, ChangeImpactViewModel } from './types.js';
import type { ReviewBrief, SuiteRunScope } from '@opensip-cli/contracts';

const REPORT_MODEL_LIMIT = 5;
const PLACEHOLDER_TEXT_LIMIT = 512;
const PLACEHOLDER_IDENTITY_LIMIT = 128;
const REPORT_BUDGET_PLACEHOLDER_REASON =
  'Detailed Change Impact presentation was omitted by the report byte budget.';
export const MAX_CHANGE_IMPACT_MODELS_BYTES = 2_097_152;

function removeLastEntity(model: ChangeImpactViewModel): ChangeImpactViewModel | undefined {
  const evidence = model.evidence;
  if (!evidence) return undefined;
  const keys = [
    'recommendedCommands',
    'impactedPackages',
    'impactedFiles',
    'impactedFunctions',
    'changedFunctions',
    'changedFiles',
  ] as const;
  for (const key of keys) {
    if (evidence[key].length === 0) continue;
    return {
      ...model,
      evidence: { ...evidence, [key]: evidence[key].slice(0, -1) },
      reportOmitted: {
        ...model.reportOmitted,
        [key]: model.reportOmitted[key] + 1,
      },
    };
  }
  if (evidence.trust.uncertainties.length > 0) {
    return {
      ...model,
      evidence: {
        ...evidence,
        trust: {
          ...evidence.trust,
          uncertainties: evidence.trust.uncertainties.slice(0, -1),
        },
      },
      reportOmitted: {
        ...model.reportOmitted,
        uncertainties: model.reportOmitted.uncertainties + 1,
      },
    };
  }
  return undefined;
}

function removeLastReviewBriefItem(
  model: ChangeImpactViewModel,
): ChangeImpactViewModel | undefined {
  const brief = model.reviewBrief;
  if (!brief) return undefined;
  const trim = <
    K extends 'topRisks' | 'newFindings' | 'correlatedRisks' | 'recommendedActions' | 'degraded',
  >(
    key: K,
    omittedKey: 'risks' | 'newFindings' | 'correlations' | 'actions' | 'degradations',
  ): ChangeImpactViewModel | undefined => {
    const values = brief[key] ?? [];
    if (values.length === 0) return undefined;
    // Drop a deterministic tail chunk instead of one row per serialization.
    // This keeps hostile oversized legacy payloads from turning the 2 MiB
    // guard into quadratic work while preserving the stored prefix order.
    const retainedLength = Math.floor(values.length / 2);
    const removed = values.length - retainedLength;
    return {
      ...model,
      reviewBrief: {
        ...brief,
        [key]: values.slice(0, retainedLength),
      },
      reportOmitted: {
        ...model.reportOmitted,
        [omittedKey]: model.reportOmitted[omittedKey] + removed,
      },
    };
  };
  return (
    trim('correlatedRisks', 'correlations') ??
    trim('recommendedActions', 'actions') ??
    trim('degraded', 'degradations') ??
    trim('newFindings', 'newFindings') ??
    trim('topRisks', 'risks')
  );
}

function boundedText(value: string, limit = PLACEHOLDER_TEXT_LIMIT): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function boundedIdentity(value: string, label: string): string {
  if (value.length <= PLACEHOLDER_IDENTITY_LIMIT) return value;
  const digest = createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 24);
  return `${label}-${digest}`;
}

function placeholderScope(scope: SuiteRunScope): SuiteRunScope {
  return {
    ...scope,
    ...(scope.ref === undefined ? {} : { ref: boundedText(scope.ref) }),
    ...(scope.notice === undefined ? {} : { notice: boundedText(scope.notice) }),
  };
}

function placeholderBrief(brief: ReviewBrief): ReviewBrief {
  return {
    version: brief.version,
    suite: boundedText(brief.suite),
    suiteRunId: boundedIdentity(brief.suiteRunId, 'suite'),
    verdict: brief.verdict,
    changedFiles: brief.changedFiles,
    topRisks: [],
    newFindings: [],
    baselineDelta: brief.baselineDelta,
    degraded: [],
    recommendedActions: [],
    ...(brief.correlatedRisks === undefined ? {} : { correlatedRisks: [] }),
  };
}

function reportBudgetPlaceholder(model: ChangeImpactViewModel): ChangeImpactViewModel | undefined {
  if (model.availabilityReason === REPORT_BUDGET_PLACEHOLDER_REASON) return undefined;
  const evidence = model.evidence;
  const brief = model.reviewBrief;
  const reportOmitted = {
    changedFiles: model.reportOmitted.changedFiles + (evidence?.changedFiles.length ?? 0),
    changedFunctions:
      model.reportOmitted.changedFunctions + (evidence?.changedFunctions.length ?? 0),
    impactedFunctions:
      model.reportOmitted.impactedFunctions + (evidence?.impactedFunctions.length ?? 0),
    impactedFiles: model.reportOmitted.impactedFiles + (evidence?.impactedFiles.length ?? 0),
    impactedPackages:
      model.reportOmitted.impactedPackages + (evidence?.impactedPackages.length ?? 0),
    recommendedCommands:
      model.reportOmitted.recommendedCommands + (evidence?.recommendedCommands.length ?? 0),
    uncertainties: model.reportOmitted.uncertainties + (evidence?.trust.uncertainties.length ?? 0),
    risks: model.reportOmitted.risks + (brief?.topRisks.length ?? 0),
    newFindings: model.reportOmitted.newFindings + (brief?.newFindings.length ?? 0),
    correlations: model.reportOmitted.correlations + (brief?.correlatedRisks?.length ?? 0),
    actions: model.reportOmitted.actions + (brief?.recommendedActions.length ?? 0),
    degradations: model.reportOmitted.degradations + (brief?.degraded.length ?? 0),
  };
  return {
    ...model,
    runId: boundedIdentity(model.runId, 'run'),
    completedAt: boundedText(model.completedAt, 64),
    ...(model.scope === undefined ? {} : { scope: placeholderScope(model.scope) }),
    ...(brief === undefined ? {} : { reviewBrief: placeholderBrief(brief) }),
    availabilityReason: REPORT_BUDGET_PLACEHOLDER_REASON,
    zeroImpact: false,
    sourceTruncated: true,
    ...(evidence === undefined
      ? {}
      : {
          evidence: {
            ...evidence,
            changedFiles: [],
            changedFunctions: [],
            impactedFunctions: [],
            impactedFiles: [],
            impactedPackages: [],
            trust: {
              ...evidence.trust,
              fallback: boundedText(evidence.trust.fallback),
              uncertainties: [],
            },
            recommendedCommands: [],
          },
        }),
    reportOmitted,
  };
}

function trimOneModel(model: ChangeImpactViewModel): ChangeImpactViewModel | undefined {
  return (
    removeLastEntity(model) ?? removeLastReviewBriefItem(model) ?? reportBudgetPlaceholder(model)
  );
}

function selectedModelIndex(
  models: readonly ChangeImpactViewModel[],
  selectedRunId: string | undefined,
): number {
  return selectedRunId === undefined
    ? -1
    : models.findIndex((model) => model.runId === selectedRunId);
}

function trimOneBoundedModel(
  models: readonly ChangeImpactViewModel[],
  selectedIndex: number,
): ChangeImpactViewModel[] | undefined {
  const candidates: number[] = [];
  for (let index = models.length - 1; index >= 0; index -= 1) {
    if (index !== selectedIndex) candidates.push(index);
  }
  if (selectedIndex >= 0) candidates.push(selectedIndex);
  for (const index of candidates) {
    const model = models[index];
    if (!model) continue;
    const trimmed = trimOneModel(model);
    if (trimmed) return models.map((item, current) => (current === index ? trimmed : item));
  }
  return undefined;
}

function lastRemovableModelIndex(length: number, selectedIndex: number): number {
  for (let index = length - 1; index >= 0; index -= 1) {
    if (index !== selectedIndex) return index;
  }
  return -1;
}

/** Keep five newest models (plus an explicit selected model) within the report byte budget. */
export function boundChangeImpactRuns(
  models: readonly ChangeImpactViewModel[],
  selectedRunId?: string,
  maxBytes = MAX_CHANGE_IMPACT_MODELS_BYTES,
): BoundedChangeImpactRuns {
  const selected =
    selectedRunId === undefined ? undefined : models.find((m) => m.runId === selectedRunId);
  const retained = models.slice(0, REPORT_MODEL_LIMIT);
  if (selected && !retained.some((model) => model.runId === selected.runId)) {
    retained[retained.length - 1] = selected;
  }
  let bounded = retained;
  while (scriptContextJsonBytes(bounded) > maxBytes) {
    // `[]` itself occupies two bytes. An artificial test budget below that is
    // unsatisfiable; returning no models is the smallest safe representation.
    if (bounded.length === 0) break;
    const selectedIndex = selectedModelIndex(bounded, selectedRunId);
    const trimmed = trimOneBoundedModel(bounded, selectedIndex);
    if (trimmed) {
      bounded = trimmed;
      continue;
    }

    const removableIndex = lastRemovableModelIndex(bounded.length, selectedIndex);
    if (removableIndex >= 0) {
      bounded = bounded.filter((_, index) => index !== removableIndex);
      continue;
    }
    // An impossibly small test budget or corrupt scalar data may make even the
    // minimal selected model too large. The byte ceiling remains authoritative.
    bounded = [];
  }
  return {
    runs: bounded,
    omittedRuns: Math.max(0, models.length - bounded.length),
  };
}
