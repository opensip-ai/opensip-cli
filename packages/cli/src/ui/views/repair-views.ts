import { group, line, type Tone, type ViewNode } from '@opensip-cli/cli-ui';

import type {
  RepairApplyResult,
  RepairApplyVerifyResult,
  RepairPreviewResult,
  RepairVerificationStatus,
} from '@opensip-cli/contracts';

const SPACER: ViewNode = { kind: 'spacer' };

type RepairResult = RepairPreviewResult | RepairApplyResult | RepairApplyVerifyResult;

function statusTone(status: RepairResult['status']): Tone {
  switch (status) {
    case 'applied':
    case 'previewed': {
      return 'success';
    }
    case 'already-applied': {
      return 'muted';
    }
    case 'refused': {
      return 'warning';
    }
  }
}

function titleFor(result: RepairResult): string {
  if (result.type === 'repair-preview') return 'Repair preview';
  if (result.type === 'repair-apply-verify') return 'Repair apply verify';
  return 'Repair apply';
}

function statusLabel(status: RepairResult['status']): string {
  return status.replace('-', ' ').toUpperCase();
}

function verificationTone(status: RepairVerificationStatus): Tone {
  switch (status) {
    case 'verified': {
      return 'success';
    }
    case 'partial': {
      return 'warning';
    }
    case 'skipped':
    case 'unverified': {
      return 'warning';
    }
  }
}

function verificationNodes(result: RepairApplyVerifyResult): readonly ViewNode[] {
  const verification = result.verification;
  const nodes: ViewNode[] = [
    SPACER,
    line([
      { text: 'Verification: ', bold: true },
      {
        text: verification.status.toUpperCase(),
        tone: verificationTone(verification.status),
        bold: true,
      },
      { text: `  ${verification.coverage}`, dim: true },
    ]),
    line([
      { text: 'Scope: ', dim: true },
      { text: verification.scope.tool, tone: 'brand' },
      { text: ` ${verification.scope.ruleId}` },
      { text: verification.scope.checkRan ? ' ran' : ' not-run', dim: true },
      { text: ` fallback=${verification.scope.fallback}`, dim: true },
    ]),
  ];
  if (verification.remainingFindings.length > 0) {
    nodes.push(
      line([
        { text: 'Remaining matching findings: ', dim: true },
        { text: String(verification.remainingFindings.length), tone: 'warning' },
      ]),
    );
  }
  if (verification.failure !== undefined) {
    nodes.push(line([{ text: verification.failure.message, tone: 'warning' }]));
  }
  if (verification.commands.length > 0) {
    nodes.push(
      line([{ text: 'Ran:', bold: true }]),
      ...verification.commands.map((command) =>
        line([{ text: `  opensip ${command.args.join(' ')}`, dim: true }]),
      ),
    );
  }
  return nodes;
}

export function viewRepair(result: RepairResult): ViewNode {
  const children: ViewNode[] = [
    line([
      { text: titleFor(result), bold: true },
      { text: '  ' },
      { text: statusLabel(result.status), tone: statusTone(result.status), bold: true },
    ]),
    line([
      { text: 'Session: ', dim: true },
      { text: result.session.id },
      { text: '  Tool: ', dim: true },
      { text: result.session.tool, tone: 'brand' },
    ]),
    line([
      { text: 'Signal: ', dim: true },
      { text: result.signal.ruleId },
      { text: `  ${result.signal.filePath ?? '-'}`, dim: true },
      ...(result.signal.line === undefined ? [] : [{ text: `:${result.signal.line}`, dim: true }]),
    ]),
    line([
      { text: 'Action: ', dim: true },
      { text: result.action.id, tone: 'brand' },
      { text: `  ${result.action.title}`, dim: true },
    ]),
  ];

  if (result.refusal !== undefined) {
    children.push(
      SPACER,
      line([{ text: result.refusal.message, tone: 'warning' }]),
      line([{ text: result.refusal.code, dim: true }]),
    );
    if (result.type === 'repair-apply-verify') {
      children.push(...verificationNodes(result));
    }
    return group(children, 2);
  }

  if (result.changes.length === 0) {
    children.push(SPACER, line([{ text: 'No file changes.', dim: true }]));
    return group(children, 2);
  }

  children.push(SPACER);
  for (const change of result.changes) {
    children.push(
      line([
        { text: change.status === 'modified' ? 'modified ' : 'unchanged ', tone: 'brand' },
        { text: change.filePath },
      ]),
    );
  }
  if (result.type === 'repair-apply-verify') {
    children.push(...verificationNodes(result));
    return group(children, 2);
  }
  if (result.verification?.commands !== undefined && result.verification.commands.length > 0) {
    children.push(
      SPACER,
      line([{ text: 'Verify:', bold: true }]),
      ...result.verification.commands.map((command) => line([{ text: `  ${command}`, dim: true }])),
    );
  }
  return group(children, 2);
}
