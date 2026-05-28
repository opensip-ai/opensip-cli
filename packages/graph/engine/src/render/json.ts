/**
 * JSON renderer — emits a CliOutput-shaped JSON document.
 *
 * Per AC-3 / DRY-1: graph emits Signal[] via the existing CliOutput
 * shape from @opensip-tools/contracts. No graph-private JSON shape.
 */

import type { Renderer } from './types.js';
import type { CheckOutput, CliOutput, FindingOutput } from '@opensip-tools/contracts';

export const renderJson: Renderer = (signals, context): string => {
  const cliOutput = buildCliOutput(signals, context.command);
  return JSON.stringify(cliOutput, null, 2);
};

export function buildCliOutput(
  signals: readonly { ruleId: string; message: string; severity: string; filePath: string; line?: number; column?: number; suggestion?: string }[],
  command: string,
): CliOutput {
  // Group findings by ruleId so each rule maps to a CheckOutput.
  const byRule = new Map<string, FindingOutput[]>();
  for (const s of signals) {
    const finding: FindingOutput = {
      ruleId: s.ruleId,
      message: s.message,
      severity: s.severity === 'critical' || s.severity === 'high' ? 'error' : 'warning',
      filePath: s.filePath,
      line: s.line,
      column: s.column,
      suggestion: s.suggestion,
    };
    let arr = byRule.get(s.ruleId);
    if (!arr) {
      arr = [];
      byRule.set(s.ruleId, arr);
    }
    arr.push(finding);
  }
  const checks: CheckOutput[] = [];
  for (const [ruleId, findings] of byRule.entries()) {
    checks.push({
      checkSlug: ruleId,
      passed: findings.length === 0,
      violationCount: findings.length,
      findings,
      durationMs: 0,
    });
  }
  const totalFindings = signals.length;
  const errors = signals.filter((s) => s.severity === 'critical' || s.severity === 'high').length;
  const warnings = totalFindings - errors;
  return {
    version: '1.0',
    tool: 'graph',
    timestamp: new Date().toISOString(),
    recipe: command,
    score: totalFindings === 0 ? 100 : Math.max(0, 100 - totalFindings),
    passed: errors === 0,
    summary: {
      total: checks.length,
      passed: checks.filter((c) => c.passed).length,
      failed: checks.filter((c) => !c.passed).length,
      errors,
      warnings,
    },
    checks,
    durationMs: 0,
  };
}

/**
 * Build a CliOutput from an aggregated FindingOutput[] — used by
 * `executePackagesGraph` after it collects per-package findings from
 * its child processes. Distinct from `buildCliOutput` because the
 * severities have already been normalized to the CliOutput vocabulary
 * (`error` | `warning`), so we trust them as-is instead of re-running
 * the Signal-severity heuristic that would mis-classify them.
 */
export function buildCliOutputFromFindings(
  findings: readonly FindingOutput[],
  command: string,
  durationMs: number,
): CliOutput {
  const byRule = new Map<string, FindingOutput[]>();
  for (const f of findings) {
    let arr = byRule.get(f.ruleId);
    if (!arr) {
      arr = [];
      byRule.set(f.ruleId, arr);
    }
    arr.push(f);
  }
  const checks: CheckOutput[] = [];
  for (const [ruleId, ruleFindings] of byRule.entries()) {
    checks.push({
      checkSlug: ruleId,
      passed: ruleFindings.length === 0,
      violationCount: ruleFindings.length,
      findings: ruleFindings,
      durationMs: 0,
    });
  }
  const totalFindings = findings.length;
  const errors = findings.filter((f) => f.severity === 'error').length;
  const warnings = totalFindings - errors;
  return {
    version: '1.0',
    tool: 'graph',
    timestamp: new Date().toISOString(),
    recipe: command,
    score: totalFindings === 0 ? 100 : Math.max(0, 100 - totalFindings),
    passed: errors === 0,
    summary: {
      total: checks.length,
      passed: checks.filter((c) => c.passed).length,
      failed: checks.filter((c) => !c.passed).length,
      errors,
      warnings,
    },
    checks,
    durationMs,
  };
}
