import type { EvalArmResult, EvalReport, EvalTaskResult } from './model.js';
import type { Arm } from '../model/task.js';

function escapeCell(value: string): string {
  return value.replaceAll('|', '\\|').replace(/[\r\n]+/gu, ' ');
}

function milliseconds(value: number | null): string {
  return value === null ? '—' : `${String(Math.round(value))} ms`;
}

function setupMilliseconds(result: EvalArmResult): number {
  const cli = result.record.setup.stages.reduce((total, stage) => total + stage.durationMs, 0);
  return (
    cli +
    (result.record.setup.mcp?.handshakeDurationMs ?? 0) +
    (result.record.setup.catalogProbe?.durationMs ?? 0)
  );
}

function setup(result: EvalArmResult): string {
  const probeBytes = result.record.setup.catalogProbe?.responseBytes ?? 0;
  return `${milliseconds(setupMilliseconds(result))} / ${String(probeBytes)} B`;
}

function verdict(result: EvalArmResult): string {
  return result.assertions.passed ? 'PASS' : 'FAIL';
}

function staleness(result: EvalArmResult): string {
  return result.assertions.staleness?.verdict ?? '—';
}

function recovery(result: EvalArmResult): string {
  const metrics = result.recoveryMetrics;
  if (metrics.callCount === 0) return '—';
  return `${String(metrics.callCount)} / ${String(metrics.responseBytes)} B / ${milliseconds(metrics.totalWallMs)}`;
}

function armRow(arm: Arm, result: EvalArmResult): string {
  return [
    arm,
    verdict(result),
    String(result.assertions.incorrectNone),
    `${String(result.metrics.responseBytes)} B`,
    String(result.metrics.callCount),
    milliseconds(result.metrics.timeToFirstUsefulContextMs),
    setup(result),
    staleness(result),
    recovery(result),
  ]
    .map((value) => escapeCell(value))
    .join(' | ')
    .replace(/^/u, '| ')
    .replace(/$/u, ' |');
}

function taskSection(task: EvalTaskResult, selectedArms: readonly Arm[]): readonly string[] {
  const rows = selectedArms.flatMap((arm) => {
    const result = task.arms[arm];
    return result === undefined ? [] : [armRow(arm, result)];
  });
  return [
    `## ${escapeCell(task.taskId)}`,
    '',
    '| Arm | Verdict | Incorrect none | Response bytes | Turns* | First useful | Setup time / catalog-probe bytes | Staleness | Recovery calls / bytes / time |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- |',
    ...rows,
    '',
  ];
}

function sourceSummary(report: EvalReport): string {
  return report.sourceState === 'clean'
    ? 'clean (promotion-eligible)'
    : `${report.sourceState} (non-promotable)`;
}

/** Render the human promotion-review companion to the immutable JSON report. */
export function renderMarkdown(report: EvalReport): string {
  const lines = [
    '# OpenSIP agent evaluation',
    '',
    `- Harness: ${escapeCell(report.harnessVersion)}`,
    `- OpenSIP CLI: ${escapeCell(report.cliVersion)}`,
    `- Contract: ${escapeCell(report.contractFingerprint)}`,
    `- Git: ${escapeCell(report.gitSha)}`,
    `- Source: ${escapeCell(sourceSummary(report))}`,
    `- Platform: ${escapeCell(report.platform)}`,
    `- Node: ${escapeCell(report.nodeVersion)}`,
    `- Started: ${escapeCell(report.startedAt)}`,
    `- Completed: ${escapeCell(report.completedAt)}`,
    '',
    '> Response bytes are the headline cross-arm unit. *Turns are deterministic tool calls, not literal model turns.',
    '',
    ...report.tasks.flatMap((task) => taskSection(task, report.selectedArms)),
  ];
  return `${lines.join('\n').trimEnd()}\n`;
}
