import { ConfigurationError } from '@opensip-cli/core';
import {
  orderSessionsForSuiteGrouping,
  resolveParentRunEvidence,
} from '@opensip-cli/session-store';

import { hostErrorCatalog } from './errors/host-error-catalog.js';

import type { StoredRun, StoredRunStep, StoredSession } from '@opensip-cli/contracts';
import type { ReportSelectionEvidence } from '@opensip-cli/dashboard';
import type { DataStore } from '@opensip-cli/datastore';

const REPORT_RUN_UNAVAILABLE = hostErrorCatalog.require('CLI.REPORT.RUN_UNAVAILABLE');

export interface ReportHistorySelection {
  readonly recentRuns: readonly StoredRun[];
  readonly stepsByRun: ReadonlyMap<string, readonly StoredRunStep[]>;
  readonly reportSessions: StoredSession[];
  readonly matchedStoredRun: boolean;
  readonly selectionEvidence?: ReportSelectionEvidence;
}

/**
 * Resolve an optional exact retained parent Run beyond the recent-history page.
 *
 * @throws {ConfigurationError} When the requested Run is absent or has no
 *   Change Impact projection.
 */
export function resolveReportHistorySelection(
  datastore: DataStore | undefined,
  requestedRunId: string | undefined,
  recentRuns: readonly StoredRun[],
  stepsByRun: ReadonlyMap<string, readonly StoredRunStep[]>,
  reportSessions: StoredSession[],
): ReportHistorySelection {
  const matchedStoredRun =
    requestedRunId !== undefined && recentRuns.some((run) => run.id === requestedRunId);
  if (requestedRunId === undefined || datastore === undefined) {
    return { recentRuns, stepsByRun, reportSessions, matchedStoredRun };
  }

  const evidence = resolveParentRunEvidence(datastore, {
    runId: requestedRunId,
    stepLimit: 500,
    sessionLimit: 500,
  });
  if (evidence.status === 'not-found') {
    throw new ConfigurationError(
      `No retained parent Run with id '${requestedRunId}'. Inspect with: opensip runs list --json`,
      {
        code: REPORT_RUN_UNAVAILABLE.code,
        definition: REPORT_RUN_UNAVAILABLE,
        metadata: { condition: 'run-not-found' },
      },
    );
  }
  const exactRun = evidence.snapshot.run;
  if (exactRun.name !== 'audit' || exactRun.source !== 'built-in-suite') {
    throw new ConfigurationError(
      `Retained parent Run '${requestedRunId}' has no Change Impact model (name=${exactRun.name}, source=${exactRun.source}). Inspect with: opensip runs show ${requestedRunId} --json`,
      {
        code: REPORT_RUN_UNAVAILABLE.code,
        definition: REPORT_RUN_UNAVAILABLE,
        metadata: { condition: 'change-impact-unavailable' },
      },
    );
  }

  const selectedRuns = recentRuns.some((run) => run.id === exactRun.id)
    ? recentRuns
    : [exactRun, ...recentRuns];
  const selectedSteps = new Map(stepsByRun);
  selectedSteps.set(exactRun.id, evidence.snapshot.steps);
  const sessionsById = new Map(reportSessions.map((session) => [session.id, session]));
  for (const session of evidence.snapshot.sessions) sessionsById.set(session.id, session);

  return {
    recentRuns: selectedRuns,
    stepsByRun: selectedSteps,
    reportSessions: orderSessionsForSuiteGrouping([...sessionsById.values()]),
    matchedStoredRun: true,
    selectionEvidence: {
      requestedRunId,
      matched: true,
      totalSteps: evidence.metadata.steps.total,
      includedSteps: evidence.metadata.steps.included,
      totalSessions: evidence.metadata.sessions.total,
      includedSessions: evidence.metadata.sessions.included,
      truncated: evidence.metadata.truncated,
    },
  };
}
