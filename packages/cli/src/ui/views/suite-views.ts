import {
  group,
  line,
  viewResultSummary,
  viewRunSummary,
  viewTable,
  type ResultSummaryItem,
  type ViewNode,
} from '@opensip-cli/cli-ui';

import { suiteContextLine, suiteReviewLine, suiteVerboseDetail } from './suite-run-detail-views.js';

import type {
  SuiteAddResult,
  SuiteListEntry,
  SuiteListResult,
  SuiteListStep,
  SuiteRunResult,
  SuiteStepSummary,
} from '@opensip-cli/contracts';

export { suiteContextLine, suiteReviewLine, suiteVerboseDetail } from './suite-run-detail-views.js';

const SPACER: ViewNode = { kind: 'spacer' };

function suiteStepRow(suite: SuiteListEntry, step: SuiteListStep) {
  return [
    { text: suite.name, tone: 'brand' as const, bold: true },
    { text: step.tool },
    { text: step.stableId, dim: true },
    { text: step.command },
    {
      text: Object.keys(step.args).length === 0 ? '-' : JSON.stringify(step.args),
      dim: Object.keys(step.args).length === 0,
    },
  ];
}

function findingCountText(count: number, label: 'error' | 'warning'): string {
  return `${count} ${label}${count === 1 ? '' : 's'}`;
}

/** A concise per-step bullet detail: the fault message, or the finding counts. */
function stepBulletDetail(step: SuiteStepSummary): string | undefined {
  if (step.kind === 'evidence') return step.readiness ?? 'unavailable';
  if (step.outcome === 'faulted') return step.error ?? 'runtime error';
  if (step.outcome === 'failed' && step.verdict !== undefined) {
    const parts: string[] = [];
    const { errors, warnings } = step.verdict;
    if (errors > 0) parts.push(findingCountText(errors, 'error'));
    if (warnings > 0) parts.push(findingCountText(warnings, 'warning'));
    return parts.length > 0 ? parts.join(', ') : undefined;
  }
  return undefined;
}

/** The suite's authoritative 3-way result count and one bullet per step. */
function resultSummaryNode(
  aggregate: NonNullable<SuiteRunResult['aggregate']>,
  steps: readonly SuiteStepSummary[],
): ViewNode {
  const items: ResultSummaryItem[] = steps.map((step) => {
    const detail = stepBulletDetail(step);
    // Dedupe when a tool's command name equals its display name.
    const label = step.tool === step.command ? step.tool : `${step.tool} ${step.command}`;
    return {
      label,
      outcome: step.outcome,
      ...(detail === undefined ? {} : { detail }),
    };
  });
  return viewResultSummary({
    counts: {
      passed: aggregate.passed,
      failed: aggregate.failed,
      faulted: aggregate.faulted,
    },
    items,
    showAll: true,
  });
}

/** Text/non-TTY suite result; the live view consumes the same detail builders. */
export function viewSuiteRun(result: SuiteRunResult): ViewNode {
  const children: ViewNode[] = [
    line([
      { text: 'Suite ', bold: true },
      { text: result.suite, tone: 'brand', bold: true },
      { text: `   Steps: ${result.steps.length}`, dim: true },
    ]),
  ];

  if (result.aggregate !== undefined) {
    children.push(resultSummaryNode(result.aggregate, result.steps));
  }
  children.push(
    viewRunSummary({
      passed: result.exitCode === 0,
      faulted: (result.aggregate?.faulted ?? 0) > 0,
      errors: result.aggregate?.errors ?? 0,
      warnings: result.aggregate?.warnings ?? 0,
      durationMs: result.durationMs,
    }),
  );
  const reviewLine = suiteReviewLine(result.reviewBrief);
  if (reviewLine !== undefined) children.push(reviewLine);
  const contextLine = suiteContextLine(result.contextManifest);
  if (contextLine !== undefined) children.push(contextLine);
  if (result.verbose === true) children.push(SPACER, suiteVerboseDetail(result));

  return group(children);
}

export function viewSuiteList(result: SuiteListResult): ViewNode {
  if (result.suites.length === 0) {
    return group([line([{ text: 'No suites configured.', dim: true }])], 2);
  }
  const rows = result.suites.flatMap((suite) =>
    suite.steps.map((step) => suiteStepRow(suite, step)),
  );
  return group([
    line([
      { text: 'Suites', bold: true },
      { text: ` (${result.totalCount})`, dim: true },
    ]),
    SPACER,
    viewTable(['Suite', 'Tool', 'UUID', 'Command', 'Args'], rows),
  ]);
}

export function viewSuiteAdd(result: SuiteAddResult): ViewNode {
  return group([
    line([
      {
        text: result.changed ? '✓' : '•',
        tone: result.changed ? 'success' : 'muted',
      },
      { text: result.changed ? ' Added ' : ' Suite already contained ' },
      { text: result.tool, tone: 'brand', bold: true },
      { text: ` ${result.command}` },
      { text: ` to ${result.suite}`, tone: 'brand' },
    ]),
    line([{ text: result.configPath, dim: true }]),
  ]);
}
