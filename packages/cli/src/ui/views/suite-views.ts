import { group, line, viewTable, type Span, type ViewNode } from '@opensip-cli/cli-ui';

import type {
  ReviewBrief,
  SuiteAddResult,
  SuiteListEntry,
  SuiteListResult,
  SuiteListStep,
  ReviewBriefDegradation,
  ReviewBriefRisk,
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

function riskLocation(risk: ReviewBriefRisk): string {
  const linePart = risk.line === undefined ? '' : `:${risk.line}`;
  const columnPart = risk.column === undefined ? '' : `:${risk.column}`;
  return `${risk.file}${linePart}${columnPart}`;
}

function riskRow(risk: ReviewBriefRisk): Span[] {
  const errorTone = risk.severity === 'critical' || risk.severity === 'high';
  return [
    { text: risk.source, tone: 'brand' },
    { text: risk.ruleId },
    { text: risk.severity, tone: errorTone ? 'error' : 'warning' },
    { text: riskLocation(risk), dim: risk.file === '' },
    { text: risk.isNew ? 'yes' : 'no', tone: risk.isNew ? 'warning' : undefined },
    { text: risk.message },
  ];
}

function degradedRow(entry: ReviewBriefDegradation): Span[] {
  return [
    { text: entry.source, tone: 'brand' },
    { text: entry.code ?? '-', dim: entry.code === undefined },
    { text: entry.reason, tone: 'warning' },
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

function reviewVerdictTone(verdict: ReviewBrief['verdict']): Span['tone'] {
  switch (verdict) {
    case 'pass': {
      return 'success';
    }
    case 'warn': {
      return 'warning';
    }
    case 'fail': {
      return 'error';
    }
  }
}

function aggregateLine(aggregate: NonNullable<SuiteRunResult['aggregate']>): ViewNode {
  return line([
    { text: 'Aggregate: ', dim: true },
    { text: `${aggregate.steps} steps`, dim: true },
    { text: `  ${aggregate.passed} passed`, tone: aggregate.passed > 0 ? 'success' : undefined },
    { text: `  ${aggregate.failed} failed`, tone: aggregate.failed > 0 ? 'error' : undefined },
    { text: `  ${aggregate.faulted} faulted`, tone: aggregate.faulted > 0 ? 'error' : undefined },
    {
      text: `  E:${aggregate.errors} W:${aggregate.warnings}`,
      dim: aggregate.errors === 0 && aggregate.warnings === 0,
    },
  ]);
}

function reviewBriefNodes(brief: ReviewBrief): ViewNode[] {
  const nodes: ViewNode[] = [
    line([
      { text: 'Review: ', dim: true },
      { text: brief.verdict.toUpperCase(), tone: reviewVerdictTone(brief.verdict), bold: true },
      { text: `  risks:${brief.topRisks.length}`, dim: brief.topRisks.length === 0 },
      { text: `  degraded:${brief.degraded.length}`, dim: brief.degraded.length === 0 },
    ]),
  ];

  if (brief.topRisks.length === 0) {
    nodes.push(line([{ text: 'No review risks found.', tone: 'success' }]));
  } else {
    nodes.push(
      SPACER,
      viewTable(
        ['Source', 'Rule', 'Severity', 'Location', 'New', 'Message'],
        brief.topRisks.slice(0, 5).map(riskRow),
      ),
    );
  }

  if (brief.degraded.length > 0) {
    nodes.push(
      SPACER,
      viewTable(['Source', 'Code', 'Reason'], brief.degraded.slice(0, 5).map(degradedRow)),
    );
  }

  return nodes;
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
    children.push(aggregateLine(result.aggregate));
  }

  if (result.reviewBrief !== undefined) {
    children.push(...reviewBriefNodes(result.reviewBrief));
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
