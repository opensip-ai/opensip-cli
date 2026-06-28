import { group, line, viewTable, type Span, type ViewNode } from '@opensip-cli/cli-ui';

import type {
  SuiteAddResult,
  SuiteListEntry,
  SuiteListResult,
  SuiteListStep,
  SuiteRunResult,
  SuiteStepSummary,
} from '@opensip-cli/contracts';

const SPACER: ViewNode = { kind: 'spacer' };

function stepSummaryRow(step: SuiteStepSummary): Span[] {
  return [
    { text: step.tool, tone: 'brand' },
    { text: step.command },
    { text: String(step.exitCode), tone: step.exitCode === 0 ? 'success' : 'error' },
    { text: `${Math.round(step.durationMs)}ms`, dim: true },
    {
      text: step.error ?? '-',
      dim: step.error === undefined,
      tone: step.error ? 'error' : undefined,
    },
  ];
}

function suiteStepRow(suite: SuiteListEntry, step: SuiteListStep): Span[] {
  return [
    { text: suite.name, tone: 'brand', bold: true },
    { text: step.tool },
    { text: step.stableId, dim: true },
    { text: step.command },
    {
      text: Object.keys(step.args).length === 0 ? '-' : JSON.stringify(step.args),
      dim: Object.keys(step.args).length === 0,
    },
  ];
}

export function viewSuiteRun(result: SuiteRunResult): ViewNode {
  return group([
    line([
      { text: 'Suite ', bold: true },
      { text: result.suite, tone: 'brand', bold: true },
      { text: ` (${result.steps.length} steps, ${Math.round(result.durationMs)}ms)`, dim: true },
    ]),
    line([
      { text: 'Exit: ', dim: true },
      { text: String(result.exitCode), tone: result.exitCode === 0 ? 'success' : 'error' },
      { text: `  Run: ${result.suiteRunId}`, dim: true },
    ]),
    SPACER,
    viewTable(['Tool', 'Command', 'Exit', 'Duration', 'Error'], result.steps.map(stepSummaryRow)),
  ]);
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
      { text: result.changed ? '✓' : '•', tone: result.changed ? 'success' : 'muted' },
      { text: result.changed ? ' Added ' : ' Suite already contained ' },
      { text: result.tool, tone: 'brand', bold: true },
      { text: ` ${result.command}` },
      { text: ` to ${result.suite}`, tone: 'brand' },
    ]),
    line([{ text: result.configPath, dim: true }]),
  ]);
}
