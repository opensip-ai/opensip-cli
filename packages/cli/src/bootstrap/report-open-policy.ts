import { decideReportOpen, type OpenReportDecision } from '../open-report.js';

import type { ReportViewSelection } from '@opensip-cli/dashboard';

export interface ReportOpenRequest {
  readonly openRequested: boolean;
  readonly jsonOutput: boolean;
}

/** Host-only effect queued behind an evidence owner's successful commit. */
export interface DeferredReportEffect {
  readonly kind: 'compose-and-open';
  readonly selection?: ReportViewSelection;
}

export type ReportOpenPlan =
  | {
      readonly status: 'skipped';
      readonly reason: string;
    }
  | {
      readonly status: 'open';
      readonly effect: DeferredReportEffect;
    };

export interface ReportOpenPlanningContext {
  readonly stdoutIsTTY: boolean;
  readonly env: NodeJS.ProcessEnv;
}

/** Apply the shared browser policy while keeping process probes in the composition root. */
export function decideCurrentReportOpen(opts: ReportOpenRequest): OpenReportDecision {
  return decideReportOpen({
    ...opts,
    stdoutIsTTY: process.stdout.isTTY === true,
    env: process.env,
  });
}

/**
 * Decide whether a report request is eligible without composing, writing, or
 * opening anything. Effect execution deliberately lives in `report.ts`.
 */
export function planReportOpen(
  opts: ReportOpenRequest,
  context?: ReportOpenPlanningContext,
): ReportOpenPlan {
  const decision =
    context === undefined
      ? decideCurrentReportOpen(opts)
      : decideReportOpen({
          ...opts,
          stdoutIsTTY: context.stdoutIsTTY,
          env: context.env,
        });
  return decision.shouldOpen
    ? { status: 'open', effect: Object.freeze({ kind: 'compose-and-open' }) }
    : { status: 'skipped', reason: decision.reason };
}
