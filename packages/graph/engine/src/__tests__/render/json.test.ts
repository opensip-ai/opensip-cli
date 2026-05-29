/**
 * Tests for the JSON renderer + buildCliOutput helper.
 */

import { createSignal } from '@opensip-tools/core';
import { describe, expect, it } from 'vitest';

import { buildCliOutput, renderJson } from '../../render/json.js';

import type { CliOutput } from '@opensip-tools/contracts';
import type { Signal } from '@opensip-tools/core';

function sig(over: { ruleId?: string; severity?: 'low' | 'medium' | 'high' | 'critical'; message?: string; filePath?: string; line?: number }): Signal {
  return createSignal({
    source: 'graph',
    severity: over.severity ?? 'low',
    category: 'quality',
    ruleId: over.ruleId ?? 'graph:test',
    message: over.message ?? 'message',
    code: { file: over.filePath ?? 'src/a.ts', line: over.line ?? 1, column: 0 },
  });
}

describe('renderJson', () => {
  it('renders an empty signals list as a valid CliOutput JSON document', () => {
    const out = renderJson([], { cwd: '/tmp', tool: 'graph', command: 'graph' });
    const parsed = JSON.parse(out) as CliOutput;
    expect(parsed.tool).toBe('graph');
    expect(parsed.recipe).toBe('graph');
    expect(parsed.checks).toHaveLength(0);
    expect(parsed.summary.total).toBe(0);
    expect(parsed.passed).toBe(true);
    expect(parsed.score).toBe(100);
  });

  it('groups signals by ruleId into CheckOutput entries', () => {
    // Per the fit-aligned per-rule pass policy (`errors === 0`), a
    // rule with only warning-severity findings still passes; use
    // 'high' here so the assertion below tests the fail branch.
    const signals = [
      sig({ ruleId: 'graph:orphan-subtree', message: 'm1', severity: 'high' }),
      sig({ ruleId: 'graph:orphan-subtree', message: 'm2', severity: 'high' }),
      sig({ ruleId: 'graph:duplicated-function-body', message: 'm3' }),
    ];
    const out = renderJson(signals, { cwd: '/tmp', tool: 'graph', command: 'graph' });
    const parsed = JSON.parse(out) as CliOutput;
    expect(parsed.checks).toHaveLength(2);
    const orphans = parsed.checks.find((c) => c.checkSlug === 'graph:orphan-subtree');
    const dups = parsed.checks.find((c) => c.checkSlug === 'graph:duplicated-function-body');
    expect(orphans?.violationCount).toBe(2);
    expect(dups?.violationCount).toBe(1);
    // orphans has 2 error-severity findings -> fails.
    expect(orphans?.passed).toBe(false);
    // dups has 1 warning-severity ('low'-mapped-to-warning) finding -> still passes per fit-alignment.
    expect(dups?.passed).toBe(true);
  });

  it('maps high/critical signal severity to error in FindingOutput', () => {
    const signals = [
      sig({ ruleId: 'r', severity: 'high', message: 'm1' }),
      sig({ ruleId: 'r', severity: 'critical', message: 'm2' }),
      sig({ ruleId: 'r', severity: 'low', message: 'm3' }),
    ];
    const cliOutput = buildCliOutput(signals, 'graph');
    expect(cliOutput.summary.errors).toBe(2);
    expect(cliOutput.summary.warnings).toBe(1);
    expect(cliOutput.passed).toBe(false);
    const finding = cliOutput.checks[0]?.findings.find((f) => f.message === 'm1');
    expect(finding?.severity).toBe('error');
  });

  it('passed=true when there are no error-severity signals', () => {
    const signals = [sig({ severity: 'low' })];
    const cliOutput = buildCliOutput(signals, 'graph');
    expect(cliOutput.passed).toBe(true);
    expect(cliOutput.summary.errors).toBe(0);
    expect(cliOutput.summary.warnings).toBe(1);
  });

  it('scores 100 for a warnings-only run regardless of finding count (fit-aligned)', () => {
    // 200 warning-severity findings under one rule: the rule still passes
    // (no errors), so the pass rate is 100% — score is passed/total checks,
    // NOT a per-finding penalty. Regression for the dashboard rendering 0%
    // PASS RATE on a warnings-only graph run while showing 4/4 checks passed.
    const signals = Array.from({ length: 200 }, (_, i) => sig({ message: `m${String(i)}` }));
    const cliOutput = buildCliOutput(signals, 'graph');
    expect(cliOutput.summary).toMatchObject({ total: 1, passed: 1, failed: 0 });
    expect(cliOutput.passed).toBe(true);
    expect(cliOutput.score).toBe(100);
  });

  it('score is the passed/total check ratio when some rules have errors', () => {
    // One error-bearing rule (fails) + one warning-only rule (passes) -> 50%.
    const signals = [
      sig({ ruleId: 'graph:has-errors', severity: 'high', message: 'e1' }),
      sig({ ruleId: 'graph:warn-only', severity: 'low', message: 'w1' }),
    ];
    const cliOutput = buildCliOutput(signals, 'graph');
    expect(cliOutput.summary).toMatchObject({ total: 2, passed: 1, failed: 1 });
    expect(cliOutput.score).toBe(50);
    expect(cliOutput.passed).toBe(false);
  });

  it('preserves filePath, line, column and suggestion in findings', () => {
    const s = createSignal({
      source: 'graph',
      severity: 'low',
      category: 'quality',
      ruleId: 'r',
      message: 'm',
      suggestion: 'fix it',
      code: { file: 'src/a.ts', line: 5, column: 3 },
    });
    const out = buildCliOutput([s], 'graph');
    const f = out.checks[0]?.findings[0];
    expect(f?.filePath).toBe('src/a.ts');
    expect(f?.line).toBe(5);
    expect(f?.column).toBe(3);
    expect(f?.suggestion).toBe('fix it');
  });
});
