import {
  buildCatalogFunctionIndex,
  catalogMatch,
  MISSING_STORED_CATALOG,
  parseEvidence,
  record,
} from './evidence.js';

import type { ChangeImpactOmittedCounts, ChangeImpactViewModel } from './types.js';
import type { GraphCatalog, StoredRun, StoredRunStep, StoredSession } from '@opensip-cli/contracts';

export { boundChangeImpactRuns, MAX_CHANGE_IMPACT_MODELS_BYTES } from './bound-runs.js';

type ImpactDashboardRun = StoredRun & {
  readonly steps: readonly StoredRunStep[];
};

const ZERO_OMITTED: ChangeImpactOmittedCounts = {
  changedFiles: 0,
  changedFunctions: 0,
  impactedFunctions: 0,
  impactedFiles: 0,
  impactedPackages: 0,
  recommendedCommands: 0,
  uncertainties: 0,
  risks: 0,
  correlations: 0,
  actions: 0,
  degradations: 0,
};

function graphImpactStep(steps: readonly StoredRunStep[]): StoredRunStep | undefined {
  return steps.find(
    (step) =>
      step.tool === 'graph' && (step.command === 'impact' || step.command === 'graph impact'),
  );
}

function baseModel(
  run: ImpactDashboardRun,
): Omit<
  ChangeImpactViewModel,
  'availability' | 'availabilityReason' | 'catalogMatch' | 'zeroImpact' | 'sourceTruncated'
> {
  return {
    runId: run.id,
    completedAt: run.completedAt,
    durationMs: run.durationMs,
    exitCode: run.exitCode,
    verdict: run.reviewBrief?.verdict ?? (run.exitCode === 0 ? 'pass' : 'fail'),
    aggregate: run.aggregate,
    ...(run.scope === undefined ? {} : { scope: run.scope }),
    ...(run.reviewBrief === undefined ? {} : { reviewBrief: run.reviewBrief }),
    reportOmitted: { ...ZERO_OMITTED },
  };
}

/** Join built-in audit runs to graph impact sessions only through RunStep.sessionId. */
export function projectChangeImpactRuns(
  runs: readonly ImpactDashboardRun[],
  sessions: readonly StoredSession[],
  currentCatalog: GraphCatalog | null,
): readonly ChangeImpactViewModel[] {
  const eligible = runs.filter((run) => run.name === 'audit' && run.source === 'built-in-suite');
  const ordered = [...eligible].sort((left, right) => {
    if (left.completedAt !== right.completedAt)
      return left.completedAt > right.completedAt ? -1 : 1;
    if (left.id < right.id) return -1;
    if (left.id > right.id) return 1;
    return 0;
  });
  const functionIndex = buildCatalogFunctionIndex(currentCatalog);
  return ordered.map((run): ChangeImpactViewModel => {
    const base = baseModel(run);
    const step = graphImpactStep(run.steps);
    if (!step) {
      return {
        ...base,
        availability: 'missing-session',
        availabilityReason: 'The graph impact step is missing.',
        catalogMatch: MISSING_STORED_CATALOG,
        zeroImpact: false,
        sourceTruncated: false,
      };
    }
    if (step.outcome === 'faulted') {
      return {
        ...base,
        availability: 'step-faulted',
        availabilityReason:
          'The graph impact step faulted before durable impact evidence was produced.',
        catalogMatch: MISSING_STORED_CATALOG,
        zeroImpact: false,
        sourceTruncated: false,
      };
    }
    if (!step.sessionId) {
      return {
        ...base,
        availability: 'missing-session',
        availabilityReason: 'The graph impact step has no stored session link.',
        catalogMatch: MISSING_STORED_CATALOG,
        zeroImpact: false,
        sourceTruncated: false,
      };
    }
    const session = sessions.find((candidate) => candidate.id === step.sessionId);
    if (!session) {
      return {
        ...base,
        availability: 'missing-session',
        availabilityReason: 'The linked graph impact session is unavailable.',
        catalogMatch: MISSING_STORED_CATALOG,
        zeroImpact: false,
        sourceTruncated: false,
      };
    }
    if (session.tool !== 'graph') {
      return {
        ...base,
        availability: 'malformed',
        availabilityReason: 'The linked session does not belong to the graph tool.',
        catalogMatch: MISSING_STORED_CATALOG,
        zeroImpact: false,
        sourceTruncated: false,
      };
    }
    const payload = record(session.payload);
    if (payload?.impactStatus === undefined) {
      return {
        ...base,
        availability: 'legacy',
        availabilityReason: 'This run predates stored Change Impact evidence.',
        catalogMatch: MISSING_STORED_CATALOG,
        zeroImpact: false,
        sourceTruncated: false,
      };
    }
    if (payload.impactStatus === 'omitted-overflow') {
      return {
        ...base,
        availability: 'projection-degraded',
        availabilityReason:
          'Impact analysis completed, but its bounded report projection could not be stored.',
        catalogMatch: MISSING_STORED_CATALOG,
        zeroImpact: false,
        sourceTruncated: false,
      };
    }
    if (payload.impactStatus !== 'available') {
      return {
        ...base,
        availability: 'malformed',
        availabilityReason: 'The stored graph impact status is not recognized.',
        catalogMatch: MISSING_STORED_CATALOG,
        zeroImpact: false,
        sourceTruncated: false,
      };
    }
    const evidence = parseEvidence(payload.impact, currentCatalog, functionIndex);
    if (!evidence) {
      return {
        ...base,
        availability: 'malformed',
        availabilityReason: 'The stored graph impact projection failed structural validation.',
        catalogMatch: MISSING_STORED_CATALOG,
        zeroImpact: false,
        sourceTruncated: false,
      };
    }
    const match = catalogMatch(evidence.catalog, currentCatalog);
    const impactedOmitted =
      evidence.backendOmitted.impactedFunctions +
      evidence.backendOmitted.impactedFiles +
      evidence.backendOmitted.impactedPackages;
    const rawImpact = record(payload.impact);
    const rawTrust = record(rawImpact?.trust);
    const rawUncertainties = Array.isArray(rawTrust?.uncertainties)
      ? rawTrust.uncertainties.length
      : 0;
    return {
      ...base,
      availability: 'available',
      availabilityReason: 'Stored graph impact evidence is available.',
      catalogMatch: match,
      zeroImpact:
        evidence.impactedFunctions.length === 0 &&
        evidence.impactedFiles.length === 0 &&
        evidence.impactedPackages.length === 0 &&
        impactedOmitted === 0,
      sourceTruncated: evidence.truncated,
      evidence,
      reportOmitted: {
        ...ZERO_OMITTED,
        uncertainties: Math.max(0, rawUncertainties - evidence.trust.uncertainties.length),
      },
    };
  });
}
