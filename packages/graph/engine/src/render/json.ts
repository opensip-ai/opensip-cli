// @fitness-ignore-file batch-operation-limits -- iterates bounded collection (rule descriptors registered for a single graph run)
/**
 * JSON renderer — emits a CliOutput-shaped JSON document.
 *
 * Per AC-3 / DRY-1: graph emits Signal[] via the existing CliOutput
 * shape from @opensip-tools/contracts. No graph-private JSON shape.
 */

import { passRate } from '@opensip-tools/contracts';

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
    // Per-rule passed matches fit's per-check semantics
    // (`types/findings.ts:187`): warnings alone do not fail a rule.
    // The user runs all three tools (fit/sim/graph) interchangeably and
    // expects the same PASS/FAIL bar across them.
    const ruleErrors = findings.filter((f) => f.severity === 'error').length;
    checks.push({
      checkSlug: ruleId,
      passed: ruleErrors === 0,
      violationCount: findings.length,
      findings,
      durationMs: 0,
    });
  }
  const totalFindings = signals.length;
  const errors = signals.filter((s) => s.severity === 'critical' || s.severity === 'high').length;
  const warnings = totalFindings - errors;
  const summary = {
    total: checks.length,
    passed: checks.filter((c) => c.passed).length,
    failed: checks.filter((c) => !c.passed).length,
    errors,
    warnings,
  };
  return {
    version: '1.0',
    tool: 'graph',
    timestamp: new Date().toISOString(),
    recipe: command,
    // Pass rate from passed/total checks — same definition as fit. A
    // warnings-only run is all-checks-passed, so it scores 100 (was a
    // `100 - findings` penalty that showed 0% for warning-heavy runs).
    score: passRate(summary),
    passed: errors === 0,
    summary,
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
    // Same fit-aligned semantics as `buildCliOutput` above: warnings
    // alone do not fail a rule.
    const ruleErrors = ruleFindings.filter((f) => f.severity === 'error').length;
    checks.push({
      checkSlug: ruleId,
      passed: ruleErrors === 0,
      violationCount: ruleFindings.length,
      findings: ruleFindings,
      durationMs: 0,
    });
  }
  const totalFindings = findings.length;
  const errors = findings.filter((f) => f.severity === 'error').length;
  const warnings = totalFindings - errors;
  const summary = {
    total: checks.length,
    passed: checks.filter((c) => c.passed).length,
    failed: checks.filter((c) => !c.passed).length,
    errors,
    warnings,
  };
  return {
    version: '1.0',
    tool: 'graph',
    timestamp: new Date().toISOString(),
    recipe: command,
    // Pass rate from passed/total checks — see buildCliOutput above.
    score: passRate(summary),
    passed: errors === 0,
    summary,
    checks,
    durationMs,
  };
}
