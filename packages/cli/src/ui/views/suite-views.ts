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

function verdictText(step: SuiteStepSummary): Span {
  const verdict = step.verdict;
  if (verdict === undefined) return { text: '-', dim: true };
  return {
    text: verdict.passed ? 'pass' : 'fail',
    tone: verdict.passed ? 'success' : 'error',
  };
}

function countsText(step: SuiteStepSummary): Span {
  const verdict = step.verdict;
  if (verdict === undefined) return { text: '-', dim: true };
  const text = `E:${verdict.errors} W:${verdict.warnings} F:${verdict.findings}`;
  let tone: Span['tone'];
  if (verdict.errors > 0) {
    tone = 'error';
  } else if (verdict.warnings > 0) {
    tone = 'warning';
  }
  return {
    text,
    tone,
    dim: verdict.errors === 0 && verdict.warnings === 0 && verdict.findings === 0,
  };
}

function stepSummaryRow(step: SuiteStepSummary): Span[] {
  return [
    { text: step.tool, tone: 'brand' },
    { text: step.command },
    { text: String(step.exitCode), tone: step.exitCode === 0 ? 'success' : 'error' },
    verdictText(step),
    countsText(step),
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
  const children: ViewNode[] = [
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
  ];

  if (result.aggregate !== undefined) {
    const a = result.aggregate;
    children.push(
      line([
        { text: 'Aggregate: ', dim: true },
        { text: `${a.steps} steps`, dim: true },
        { text: `  ${a.passed} passed`, tone: a.passed > 0 ? 'success' : undefined },
        { text: `  ${a.failed} failed`, tone: a.failed > 0 ? 'error' : undefined },
        { text: `  ${a.faulted} faulted`, tone: a.faulted > 0 ? 'error' : undefined },
        { text: `  E:${a.errors} W:${a.warnings}`, dim: a.errors === 0 && a.warnings === 0 },
      ]),
    );
  }

  children.push(
    SPACER,
    viewTable(
      ['Tool', 'Command', 'Exit', 'Verdict', 'Counts', 'Duration', 'Error'],
      result.steps.map(stepSummaryRow),
    ),
  );

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
      { text: result.changed ? '✓' : '•', tone: result.changed ? 'success' : 'muted' },
      { text: result.changed ? ' Added ' : ' Suite already contained ' },
      { text: result.tool, tone: 'brand', bold: true },
      { text: ` ${result.command}` },
      { text: ` to ${result.suite}`, tone: 'brand' },
    ]),
    line([{ text: result.configPath, dim: true }]),
  ]);
}
