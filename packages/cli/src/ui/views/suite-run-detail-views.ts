import { group, line, viewTable, type Span, type ViewNode } from '@opensip-cli/cli-ui';
import { formatDuration } from '@opensip-cli/format';

import type {
  ReviewBrief,
  ReviewBriefCorrelationGroup,
  ReviewBriefDegradation,
  ReviewBriefRisk,
  SuiteRunResult,
  SuiteStepSummary,
  TaskContextManifest,
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

function contextReadinessTone(
  readiness: TaskContextManifest['readiness'] | undefined,
): Span['tone'] {
  switch (readiness) {
    case 'ready': {
      return 'success';
    }
    case 'degraded': {
      return 'warning';
    }
    case 'unavailable':
    case undefined: {
      return 'error';
    }
  }
}

function countsText(step: SuiteStepSummary): Span {
  if (step.kind === 'evidence') {
    return {
      text: step.readiness ?? 'unavailable',
      tone: contextReadinessTone(step.readiness),
    };
  }
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
    { text: OUTCOME_WORD[step.outcome], tone: OUTCOME_TONE[step.outcome] },
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

function correlatedRiskRow(riskGroup: ReviewBriefCorrelationGroup): Span[] {
  const tools = [...new Set(riskGroup.members.map((member) => member.signalRef.tool))].join(',');
  const reason = riskGroup.reasons[0]?.kind ?? '-';
  const errorTone = riskGroup.severity === 'critical' || riskGroup.severity === 'high';
  return [
    { text: riskGroup.primary.ruleId },
    {
      text: String(riskGroup.members.length),
      tone: riskGroup.members.length > 1 ? 'warning' : undefined,
    },
    { text: tools },
    { text: riskGroup.severity, tone: errorTone ? 'error' : 'warning' },
    { text: reason },
    { text: riskGroup.title },
  ];
}

function degradedRow(entry: ReviewBriefDegradation): Span[] {
  return [
    { text: entry.source, tone: 'brand' },
    { text: entry.code ?? '-', dim: entry.code === undefined },
    { text: entry.reason, tone: 'warning' },
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

function changedScopeText(scope: NonNullable<SuiteRunResult['scope']>): string {
  const fileCount = (count: number): string => `${count} ${count === 1 ? 'file' : 'files'}`;
  if (scope.ref !== undefined) {
    const count = scope.changedFiles === undefined ? '' : ` (${fileCount(scope.changedFiles)})`;
    return `changed since ${scope.ref}${count}`;
  }
  if (scope.source === 'explicit') {
    return scope.changedFiles === undefined
      ? 'changed'
      : `changed (${fileCount(scope.changedFiles)})`;
  }
  const count = scope.changedFiles === undefined ? '' : `, ${fileCount(scope.changedFiles)}`;
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

/** One-line review verdict shared by text and live suite views. */
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

/** One-line evidence readiness summary for the non-finding context suite. */
export function suiteContextLine(manifest: TaskContextManifest | undefined): ViewNode | undefined {
  if (manifest === undefined) return undefined;
  return line([
    { text: 'Context: ', dim: true },
    {
      text: manifest.readiness.toUpperCase(),
      tone: contextReadinessTone(manifest.readiness),
      bold: true,
    },
    {
      text: ` · ${String(manifest.planes.length)} evidence plane${manifest.planes.length === 1 ? '' : 's'}`,
      dim: true,
    },
  ]);
}

function contextPlaneTone(status: TaskContextManifest['planes'][number]['status']): Span['tone'] {
  switch (status) {
    case 'rebuilt':
    case 'reused': {
      return 'success';
    }
    case 'failed':
    case 'cancelled': {
      return 'error';
    }
    case 'partial':
    case 'unsupported': {
      return 'warning';
    }
  }
}

/** Scope, step, risk, and evidence tables used only by `--verbose`. */
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
  const manifest = result.contextManifest;
  if (manifest !== undefined) {
    nodes.push(
      SPACER,
      viewTable(
        ['Plane', 'Required', 'Status', 'Coverage', 'Follow-up'],
        manifest.planes.map((plane) => [
          { text: plane.kind, tone: 'brand' },
          { text: plane.required ? 'yes' : 'no' },
          { text: plane.status, tone: contextPlaneTone(plane.status) },
          { text: plane.coverage.status },
          { text: plane.followUpReads.join(', ') || '-', dim: plane.followUpReads.length === 0 },
        ]),
      ),
    );
  }
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
