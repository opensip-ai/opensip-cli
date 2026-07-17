/** Human views for canonical parent Runs and their ordered RunSteps. */

import {
  group,
  line,
  viewTable,
  type Span,
  type TableColumnSpec,
  type Tone,
  type ViewNode,
} from '@opensip-cli/cli-ui';
import { formatDuration } from '@opensip-cli/format';

import type { RunDetailResult, RunHistoryResult, StoredRun } from '@opensip-cli/contracts';

const SPACER: ViewNode = { kind: 'spacer' };

function parentRunPassed(run: StoredRun): boolean {
  return run.exitCode === 0 && run.aggregate.failed === 0 && run.aggregate.faulted === 0;
}

function parentRunRow(summary: RunHistoryResult['runs'][number]): readonly Span[] {
  const { run } = summary;
  const passed = parentRunPassed(run);
  return [
    { text: run.id, bold: true },
    { text: run.name, tone: 'brand' },
    { text: run.source },
    { text: new Date(run.startedAt).toLocaleString(), dim: true },
    { text: passed ? 'PASS' : 'FAIL', tone: passed ? 'success' : 'error' },
    { text: String(run.aggregate.steps) },
    { text: formatDuration(run.durationMs), dim: true },
  ];
}

const PARENT_RUN_COLUMNS: readonly (string | TableColumnSpec)[] = [
  'Parent Run',
  'Name',
  'Source',
  'When',
  'Outcome',
  { header: 'Steps', align: 'right' },
  { header: 'Duration', align: 'right' },
];

/** Compact parent-ledger history; Tool Session replay remains a separate surface. */
export function viewRunHistory(result: RunHistoryResult): ViewNode {
  if (result.runs.length === 0) {
    return group(
      [
        line([
          {
            text: 'No parent Runs recorded yet. Run opensip audit or another analysis command.',
            dim: true,
          },
        ]),
      ],
      2,
    );
  }

  const children: ViewNode[] = [
    line([
      { text: 'Parent Runs', bold: true },
      { text: ` (${String(result.runs.length)} shown)`, dim: true },
    ]),
    SPACER,
    viewTable(PARENT_RUN_COLUMNS, result.runs.map(parentRunRow)),
  ];
  if (result.truncated) {
    children.push(
      line([
        {
          text: `Showing the first ${String(result.effectiveLimit)} results (requested ${String(result.requestedLimit)}).`,
          dim: true,
        },
      ]),
    );
  }
  children.push(
    SPACER,
    line([{ text: 'Inspect', bold: true }]),
    ...result.runs.map((summary) => line([{ text: summary.showCommand, tone: 'brand' }])),
  );
  return group(children, 2);
}

function runStepTone(step: RunDetailResult['steps'][number]): Tone {
  if (step.outcome === 'passed') return 'success';
  if (step.outcome === 'failed') return 'error';
  return 'warning';
}

function runStepRow(step: RunDetailResult['steps'][number]): readonly Span[] {
  return [
    { text: String(step.ordinal) },
    { text: String(step.attempt) },
    { text: step.tool, tone: 'brand', bold: true },
    { text: step.command },
    { text: step.outcome.toUpperCase(), tone: runStepTone(step) },
    { text: step.sessionId ?? '—', dim: step.sessionId === undefined },
    { text: formatDuration(step.durationMs), dim: true },
  ];
}

const RUN_STEP_COLUMNS: readonly (string | TableColumnSpec)[] = [
  { header: '#', align: 'right' },
  { header: 'Attempt', align: 'right' },
  'Tool',
  'Command',
  'Outcome',
  'Session',
  { header: 'Duration', align: 'right' },
];

/** Exact parent Run plus its bounded, ordered RunStep page and Session follow-ups. */
export function viewRunDetail(result: RunDetailResult): ViewNode {
  const { aggregate } = result.run;
  const passed = parentRunPassed(result.run);
  const stepLabel = aggregate.steps === 1 ? 'step' : 'steps';
  const children: ViewNode[] = [
    line([
      { text: 'Parent Run ', bold: true },
      { text: result.run.id, bold: true },
    ]),
    line([
      { text: result.run.name, tone: 'brand' },
      { text: ` · ${result.run.source}`, dim: true },
      { text: ` · ${passed ? 'PASS' : 'FAIL'}`, tone: passed ? 'success' : 'error' },
      { text: ` · exit ${String(result.run.exitCode)}`, dim: true },
      { text: ` · ${formatDuration(result.run.durationMs)}`, dim: true },
    ]),
    line([
      {
        text:
          `${String(aggregate.steps)} ${stepLabel} · ${String(aggregate.passed)} passed · ` +
          `${String(aggregate.failed)} failed · ${String(aggregate.faulted)} faulted · ` +
          `${String(aggregate.errors)} errors · ${String(aggregate.warnings)} warnings`,
        dim: true,
      },
    ]),
    SPACER,
  ];

  if (result.steps.length === 0) {
    children.push(line([{ text: 'No RunSteps in this page.', dim: true }]));
  } else {
    children.push(
      line([
        { text: 'RunSteps', bold: true },
        {
          text: ` (${String(result.steps.length)} of ${String(result.total)}, offset ${String(result.offset)})`,
          dim: true,
        },
      ]),
      viewTable(RUN_STEP_COLUMNS, result.steps.map(runStepRow)),
    );
  }

  if (result.nextOffset !== undefined) {
    children.push(
      line([
        {
          text:
            `Next page: opensip runs show ${result.run.id} --offset ` +
            `${String(result.nextOffset)} --limit ${String(result.limit)} --json`,
          tone: 'brand',
        },
      ]),
    );
  }
  if (result.sessionFollowUps.length > 0) {
    children.push(
      SPACER,
      line([{ text: 'Linked Tool Sessions', bold: true }]),
      ...result.sessionFollowUps.map((followUp) =>
        line([
          { text: `${followUp.runStepId}: `, dim: true },
          { text: followUp.showCommand, tone: 'brand' },
        ]),
      ),
    );
  }

  return group(children, 2);
}
