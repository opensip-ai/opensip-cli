/**
 * Project persisted input into bounded, browser-facing report artifacts.
 *
 * These helpers own structural reduction and graph recovery; the HTML generator
 * only serializes their already-bounded outputs.
 */

import { boundGraphCatalog } from './code-paths/bound-catalog.js';
import { projectCatalogToGraphViewModel } from './code-paths/graph-view-model.js';
import { dashboardCodePathsVendorJs } from './code-paths.js';

import type { GraphCatalog, StoredRun, StoredRunStep, StoredSession } from '@opensip-cli/contracts';

/** A persisted host-owned run plus its ordered steps for dashboard rendering. */
export interface DashboardRun extends StoredRun {
  readonly steps: readonly StoredRunStep[];
}

type OverviewDashboardRun = Pick<
  DashboardRun,
  | 'aggregate'
  | 'completedAt'
  | 'durationMs'
  | 'exitCode'
  | 'id'
  | 'legacySuiteRunId'
  | 'name'
  | 'source'
  | 'startedAt'
  | 'steps'
>;

/** Keep the Overview ledger lean; Change Impact owns the bounded ReviewBrief copy. */
export function projectOverviewRuns(
  runs: readonly DashboardRun[],
): readonly OverviewDashboardRun[] {
  return runs.map((run) => ({
    id: run.id,
    name: run.name,
    source: run.source,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    durationMs: run.durationMs,
    exitCode: run.exitCode,
    aggregate: run.aggregate,
    steps: run.steps,
    ...(run.legacySuiteRunId === undefined ? {} : { legacySuiteRunId: run.legacySuiteRunId }),
  }));
}

/** Remove impact's duplicate opaque copy after the bounded Change Impact model is projected. */
export function projectBrowserSessions(
  sessions: readonly StoredSession[],
): readonly StoredSession[] {
  return sessions.map((session) => {
    const payload = session.payload;
    if (
      session.tool !== 'graph' ||
      typeof payload !== 'object' ||
      payload === null ||
      Array.isArray(payload)
    ) {
      return session;
    }
    const browserPayload = Object.fromEntries(
      Object.entries(payload).filter(([key]) => key !== 'impact' && key !== 'impactStatus'),
    );
    return { ...session, payload: browserPayload };
  });
}

/** Fixed, non-sensitive recovery evidence embedded for the graph visualization. */
export interface GraphVisualizationDegradation {
  readonly condition: 'catalog-projection-failed' | 'renderer-asset-unavailable';
  readonly message: string;
}

/**
 * Bound and project a stored graph catalog, degrading malformed input to an
 * explicit browser-visible recovery record.
 */
export function graphArtifacts(
  graphCatalog: GraphCatalog | null,
  maxGraphCatalogBytes: number | undefined,
): {
  readonly boundedCatalog: ReturnType<typeof boundGraphCatalog>;
  readonly catalog: GraphCatalog | null;
  readonly graphViewModel: ReturnType<typeof projectCatalogToGraphViewModel> | null;
  readonly degradations: readonly GraphVisualizationDegradation[];
} {
  if (graphCatalog === null) {
    return {
      boundedCatalog: boundGraphCatalog(null, maxGraphCatalogBytes),
      catalog: null,
      graphViewModel: null,
      degradations: [],
    };
  }
  try {
    return {
      boundedCatalog: boundGraphCatalog(graphCatalog, maxGraphCatalogBytes),
      catalog: graphCatalog,
      graphViewModel: projectCatalogToGraphViewModel(graphCatalog),
      degradations: [],
    };
  } catch {
    return {
      boundedCatalog: boundGraphCatalog(null, maxGraphCatalogBytes),
      catalog: null,
      graphViewModel: null,
      degradations: [
        {
          condition: 'catalog-projection-failed',
          message:
            'Graph exploration is unavailable because the stored catalog is malformed. Run `opensip graph`, then regenerate this report.',
        },
      ],
    };
  }
}

/** Load the self-contained graph renderer or return fixed visible degradation evidence. */
export function codePathsVendor(): {
  readonly javascript: string;
  readonly degradation?: GraphVisualizationDegradation;
} {
  try {
    return { javascript: dashboardCodePathsVendorJs() };
  } catch {
    return {
      javascript: '',
      degradation: {
        condition: 'renderer-asset-unavailable',
        message:
          'Graph visualization is unavailable because its renderer asset is missing. Reinstall opensip-cli or run `pnpm --filter=@opensip-cli/dashboard vendor:cytoscape`, then regenerate this report.',
      },
    };
  }
}
