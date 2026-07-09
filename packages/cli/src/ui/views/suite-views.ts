import {
  group,
  line,
  viewResultSummary,
  viewRunSummary,
  viewTable,
  type ResultSummaryItem,
  type Span,
  type ViewNode,
} from '@opensip-cli/cli-ui';
import { formatDuration } from '@opensip-cli/format';

import type {
  ReviewBrief,
  SuiteAddResult,
  SuiteListEntry,
  SuiteListResult,
  SuiteListStep,
  ReviewBriefCorrelationGroup,
  ReviewBriefDegradation,
  ReviewBriefRisk,
  SuiteRunResult,
  SuiteStepSummary,
} from '@opensip-cli/contracts';

const SPACER: ViewNode = { kind: 'spacer' };

const OUTCOME_WORD: Record<SuiteStepSummary['outcome'], string> = {
  passed: 'pass',
  failed: 'fail',
  faulted: 'fault',
};

const OUTCOME_TONE: Record<SuiteStepSummary['outcome'], Span['tone']> = {
  passed: 'success',
  failed: 'error',
  faulted: 'warning',
};

function verdictText(step: SuiteStepSummary): Span {
  // Render the authoritative 3-way outcome (a fault reads `fault`, not `fail`),
  // not the binary `verdict.passed` — that collapsed a runtime fault into `fail`.
  return { text: OUTCOME_WORD[step.outcome], tone: OUTCOME_TONE[step.outcome] };
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
    {
      text: String(step.exitCode),
      tone: step.exitCode === 0 ? 'success' : 'error',
    },
    verdictText(step),
    countsText(step),
    { text: formatDuration(step.durationMs), dim: true },
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
    {
      text: risk.isNew ? 'yes' : 'no',
      tone: risk.isNew ? 'warning' : undefined,
    },
    { text: risk.message },
  ];
}

function correlatedRiskRow(group: ReviewBriefCorrelationGroup): Span[] {
  const tools = [...new Set(group.members.map((member) => member.signalRef.tool))].join(',');
  const reason = group.reasons[0]?.kind ?? '-';
  const errorTone = group.severity === 'critical' || group.severity === 'high';
  return [
    { text: group.primary.ruleId },
    {
      text: String(group.members.length),
      tone: group.members.length > 1 ? 'warning' : undefined,
    },
    { text: tools },
    { text: group.severity, tone: errorTone ? 'error' : 'warning' },
    { text: reason },
    { text: group.title },
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

/** A concise per-step bullet detail: the fault message, or the finding counts. */
function stepBulletDetail(step: SuiteStepSummary): string | undefined {
  if (step.outcome === 'faulted') return step.error ?? 'runtime error';
  if (step.outcome === 'failed' && step.verdict !== undefined) {
    const parts: string[] = [];
    const { errors, warnings } = step.verdict;
    if (errors > 0) parts.push(`${errors} error${errors === 1 ? '' : 's'}`);
    if (warnings > 0) parts.push(`${warnings} warning${warnings === 1 ? '' : 's'}`);
    return parts.length > 0 ? parts.join(', ') : undefined;
  }
  return undefined;
}

/**
 * The suite's 3-way result block — the count line + one bullet per step. Keyed on
 * the aggregate's authoritative counts and each step's `outcome`, so a runtime
 * fault reads as `fault`, distinct from a findings `fail`. A suite lists every
 * step (`showAll`), per the fault-taxonomy display contract.
 */
function resultSummaryNode(
  aggregate: NonNullable<SuiteRunResult['aggregate']>,
  steps: readonly SuiteStepSummary[],
): ViewNode {
  const items: ResultSummaryItem[] = steps.map((step) => {
    const detail = stepBulletDetail(step);
    // Dedupe when a tool's command name equals its display name (e.g. 'fitness
    // fitness' / 'yagni yagni') — show the tool once.
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

function fileCountLabel(count: number): string {
  return `${count} ${count === 1 ? 'file' : 'files'}`;
}

function changedScopeText(scope: NonNullable<SuiteRunResult['scope']>): string {
  if (scope.ref !== undefined) {
    const count =
      scope.changedFiles === undefined ? '' : ` (${fileCountLabel(scope.changedFiles)})`;
    return `changed since ${scope.ref}${count}`;
  }

  if (scope.source === 'explicit') {
    return scope.changedFiles === undefined
      ? 'changed'
      : `changed (${fileCountLabel(scope.changedFiles)})`;
  }

  const count = scope.changedFiles === undefined ? '' : `, ${fileCountLabel(scope.changedFiles)}`;
  return `changed (working tree${count})`;
}

function scopeLine(result: SuiteRunResult): ViewNode[] {
  const scope = result.scope;
  if (scope === undefined) return [];

  if (scope.mode === 'changed') {
    return [line([{ text: 'Scope: ', dim: true }, { text: changedScopeText(scope) }])];
  }

  if (scope.source === 'explicit') {
    return [line([{ text: 'Scope: ', dim: true }, { text: 'full (--full)' }])];
  }

  if (scope.source === 'fallback') {
    return [
      line([{ text: 'Scope: ', dim: true }, { text: 'full' }]),
      ...(scope.notice === undefined ? [] : [line([{ text: scope.notice, tone: 'warning' }])]),
    ];
  }

  return [line([{ text: 'Scope: ', dim: true }, { text: 'full' }])];
}

/**
 * The suite's ONE-LINE review verdict, shown directly under the run summary on
 * every surface (the §4 `summaryNote`): `Review: PASS · no risks found` or
 * `Review: FAIL · 2 risks · 1 degraded`. Full risk tables are `--verbose` only
 * (see {@link suiteVerboseDetail}). Returns `undefined` when there is no brief.
 */
export function suiteReviewLine(brief: ReviewBrief | undefined): ViewNode | undefined {
  if (brief === undefined) return undefined;
  const risks = brief.topRisks.length;
  const correlated = brief.correlatedRisks?.length ?? 0;
  const degraded = brief.degraded.length;
  const detail: string[] = [];
  if (risks > 0) detail.push(`${risks} risk${risks === 1 ? '' : 's'}`);
  if (correlated > 0) detail.push(`${correlated} correlated`);
  if (degraded > 0) detail.push(`${degraded} degraded`);
  return line([
    { text: 'Review: ', dim: true },
    { text: brief.verdict.toUpperCase(), tone: reviewVerdictTone(brief.verdict), bold: true },
    detail.length === 0
      ? { text: ' · no risks found', dim: true }
      : { text: ` · ${detail.join(' · ')}`, dim: true },
  ]);
}

/**
 * The suite's `--verbose` detail: scope + run id, the per-step table, and the
 * review-risk / correlation / degradation tables. Additive detail above the
 * summary (the §4 `verboseExtra`), NOT part of the default surface.
 */
export function suiteVerboseDetail(result: SuiteRunResult): ViewNode {
  const nodes: ViewNode[] = [
    ...scopeLine(result),
    line([{ text: `Run: ${result.suiteRunId}`, dim: true }]),
    SPACER,
    viewTable(
      ['Tool', 'Command', 'Exit', 'Verdict', 'Counts', 'Duration', 'Error'],
      result.steps.map(stepSummaryRow),
    ),
  ];
  const brief = result.reviewBrief;
  if (brief !== undefined && brief.topRisks.length > 0) {
    nodes.push(
      SPACER,
      viewTable(
        ['Source', 'Rule', 'Severity', 'Location', 'New', 'Message'],
        brief.topRisks.slice(0, 5).map(riskRow),
      ),
    );
  }
  if (brief !== undefined && (brief.correlatedRisks?.length ?? 0) > 0) {
    nodes.push(
      SPACER,
      viewTable(
        ['Primary', 'Members', 'Tools', 'Severity', 'Reason', 'Title'],
        brief.correlatedRisks?.slice(0, 5).map(correlatedRiskRow) ?? [],
      ),
    );
  }
  if (brief !== undefined && brief.degraded.length > 0) {
    nodes.push(
      SPACER,
      viewTable(['Source', 'Code', 'Reason'], brief.degraded.slice(0, 5).map(degradedRow)),
    );
  }
  return group(nodes);
}

/**
 * The suite result as a text view (the non-TTY / pipe render). Mirrors the live
 * TTY shell's sections in text: a title band (name + step count), the per-step
 * outcome list, the canonical `PASS (E, W) | Duration` run-summary line, then the
 * one-line review verdict. Per-step + risk TABLES are `--verbose` only.
 */
export function viewSuiteRun(result: SuiteRunResult): ViewNode {
  const verbose = result.verbose === true;
  const children: ViewNode[] = [
    line([
      { text: 'Suite ', bold: true },
      { text: result.suite, tone: 'brand', bold: true },
      { text: `   Steps: ${result.steps.length}`, dim: true },
    ]),
  ];

  // §3: the per-step outcome list (the pipe equivalent of the TTY checklist).
  if (result.aggregate !== undefined) {
    children.push(resultSummaryNode(result.aggregate, result.steps));
  }

  // §4: the canonical run-summary headline + the one-line review verdict.
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

  if (verbose) children.push(SPACER, suiteVerboseDetail(result));

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
