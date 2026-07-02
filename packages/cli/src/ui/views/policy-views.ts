import {
  group,
  line,
  viewTable,
  type Span,
  type TableColumnSpec,
  type Tone,
  type ViewNode,
} from '@opensip-cli/cli-ui';

import type {
  CommandResult,
  PolicyAuditResult,
  PolicyAuditRow,
  PolicyExplainResult,
  PolicyStatusResult,
} from '@opensip-cli/contracts';

const SPACER: ViewNode = { kind: 'spacer' };

const EXCEPTIONS_COLUMNS: readonly (string | TableColumnSpec)[] = [
  'ID',
  'Subject',
  'Action',
  'Expires',
  'Source',
];

const AUDIT_COLUMNS: readonly (string | TableColumnSpec)[] = [
  'Time',
  'Outcome',
  'Action',
  'Subject',
  'Reasons',
];

function outcomeTone(outcome: string): Tone {
  if (outcome === 'deny') return 'error';
  if (outcome === 'allow-with-conditions') return 'warning';
  return 'success';
}

function auditRow(row: PolicyAuditRow): Span[] {
  return [
    { text: row.timestamp },
    { text: row.outcome, tone: outcomeTone(row.outcome) },
    { text: row.action },
    { text: row.subject, tone: 'brand' },
    { text: row.reasons.length === 0 ? '-' : row.reasons.join('; ') },
  ];
}

type PolicyCommandResult = Extract<
  CommandResult,
  { type: 'policy-status' | 'policy-explain' | 'policy-audit' }
>;

/** @throws {Error} When the closed policy result union and renderer drift. */
function assertPolicyNever(result: never): never {
  throw new Error(`Unhandled policy command result '${JSON.stringify(result)}'`);
}

export function viewPolicyResult(result: PolicyCommandResult): ViewNode {
  switch (result.type) {
    case 'policy-status': {
      return viewPolicyStatus(result);
    }
    case 'policy-explain': {
      return viewPolicyExplain(result);
    }
    case 'policy-audit': {
      return viewPolicyAudit(result);
    }
    default: {
      return assertPolicyNever(result);
    }
  }
}

export function viewPolicyStatus(result: PolicyStatusResult): ViewNode {
  const children: ViewNode[] = [
    line([
      { text: 'Policy', bold: true },
      { text: `  mode ${result.mode}`, tone: result.mode === 'strict' ? 'warning' : 'muted' },
      { text: `  ci ${result.ci}`, tone: result.ci === 'strict' ? 'warning' : 'muted' },
    ]),
    line([
      { text: 'Org: ', dim: true },
      {
        text: result.orgStatus.state,
        tone: result.orgStatus.state === 'required-unavailable' ? 'error' : 'muted',
      },
      ...(result.orgStatus.reason === undefined
        ? []
        : [{ text: ` (${result.orgStatus.reason})`, dim: true }]),
    ]),
    line([{ text: `Sources: ${result.sources.join(', ') || 'builtin'}`, dim: true }]),
  ];
  if (result.exceptions.length > 0) {
    children.push(
      SPACER,
      viewTable(
        EXCEPTIONS_COLUMNS,
        result.exceptions.map((exception) => [
          { text: exception.id, tone: 'brand' },
          { text: exception.subject },
          { text: exception.action },
          { text: exception.expiresAt ?? '-', dim: exception.expiresAt === undefined },
          { text: exception.sourceTier },
        ]),
      ),
    );
  }
  return group(children, 2);
}

export function viewPolicyExplain(result: PolicyExplainResult): ViewNode {
  return group(
    [
      line([
        { text: 'Policy decision', bold: true },
        { text: `  ${result.action}`, dim: true },
        { text: `  ${result.subject}`, tone: 'brand' },
      ]),
      line([
        { text: 'Outcome: ', dim: true },
        {
          text: result.decision.outcome,
          tone: outcomeTone(result.decision.outcome),
          bold: true,
        },
      ]),
      ...result.decision.reasons.map((reason) => line([{ text: `  ${reason}` }])),
      ...(result.decision.matchedExceptionIds.length === 0
        ? []
        : [
            line([
              { text: 'Exceptions: ', dim: true },
              { text: result.decision.matchedExceptionIds.join(', ') },
            ]),
          ]),
    ],
    2,
  );
}

export function viewPolicyAudit(result: PolicyAuditResult): ViewNode {
  if (result.events.length === 0) {
    return group([line([{ text: 'No policy audit events recorded.', dim: true }])], 2);
  }
  const children: ViewNode[] = [
    line([
      { text: 'Policy audit', bold: true },
      { text: ` (${result.totalCount})`, dim: true },
      ...(result.exportedTo === undefined
        ? []
        : [{ text: `  exported ${result.exportedTo}`, dim: true }]),
    ]),
    SPACER,
    viewTable(AUDIT_COLUMNS, result.events.map(auditRow)),
  ];
  return group(children, 2);
}
