import { renderToText } from '@opensip-tools/cli-ui';
import { describe, it, expect } from 'vitest';

import { resultToView } from '../result-to-view.js';

import type { CommandResult, SimDoneResult } from '@opensip-tools/contracts';

function textOf(result: CommandResult): string {
  return renderToText(resultToView(result));
}

describe('resultToView', () => {
  it('renders fit-done: table, summary, findings, and cloud-report status', () => {
    const out = textOf({
      type: 'fit-done',
      label: 'fit',
      cwd: '/x',
      rows: [
        { check: 'no-console', status: 'FAIL', errors: 2, warnings: 0, validated: '10 files', ignored: 0, duration: '5ms', durationMs: 5 },
        { check: 'naming', status: 'PASS', errors: 0, warnings: 1, validated: '10 files', ignored: 0, duration: '3ms', durationMs: 3 },
      ],
      summary: { passed: 1, failed: 1, totalErrors: 2, totalWarnings: 1, totalIgnored: 0, durationMs: 8 },
      findings: {
        checks: [
          { checkSlug: 'no-console', passed: false, findings: [{ ruleId: 'no-console', message: 'console.log', severity: 'error', filePath: 'a.ts', line: 3 }], durationMs: 5 },
        ],
      },
      reportStatus: { url: 'https://x', findingCount: 3, runCount: 2, success: true },
    });
    // Table: FAIL sorts above PASS, header + separator present.
    expect(out).toContain('Check');
    expect(out).toContain('Status');
    expect(out.indexOf('no-console')).toBeLessThan(out.indexOf('naming')); // FAIL before PASS
    // Shared summary line.
    expect(out).toContain('1 Passed, 1 Failed (2 Errors, 1 Warnings) | Duration 8ms');
    // Findings detail + cloud status.
    expect(out).toContain('Findings (1):');
    expect(out).toContain('error  console.log a.ts:3');
    expect(out).toContain('Reported to https://x');
  });

  it('renders fit-done failure branches: check error, warn finding, truncation, failed cloud report', () => {
    const manyFindings = Array.from({ length: 30 }, (_, i) => ({
      ruleId: 'r',
      message: `w${i}`,
      severity: 'warning' as const,
      filePath: 'b.ts',
    }));
    const out = textOf({
      type: 'fit-done',
      label: 'fit',
      cwd: '/x',
      rows: [{ check: 'broken', status: 'TIMEOUT', errors: 0, warnings: 0, validated: '—', ignored: 3, duration: '60s', durationMs: 61_000 }],
      summary: { passed: 0, failed: 1, totalErrors: 0, totalWarnings: 30, totalIgnored: 3, durationMs: 100 },
      findings: {
        checks: [
          { checkSlug: 'loader', passed: false, findings: [], durationMs: 1, error: 'failed to load' },
          { checkSlug: 'naming', passed: false, findings: manyFindings, durationMs: 2 },
        ],
      },
      reportStatus: { url: 'https://x', findingCount: 0, runCount: 1, success: false, error: 'network down', chunksTotal: 3, chunksSucceeded: 1 },
    });
    expect(out).toContain('error  failed to load'); // check-level error
    expect(out).toContain('warn  w0'); // warning finding
    expect(out).toContain('… 5 more hidden'); // 30 - 25 cap
    expect(out).toContain('Showing first 25 violations per check');
    expect(out).toContain('Partially reported to https://x (1/3 chunks)'); // partial cloud failure
    expect(out).toContain('network down');
  });

  it('renders help and list views (every result type is now total)', () => {
    expect(renderToText(resultToView({ type: 'help' }))).toContain('Codebase analysis toolkit');
    expect(renderToText(resultToView({ type: 'list-recipes', recipes: [{ name: 'example', description: 'demo', checkCount: '3 checks' }] }))).toContain('example');
  });

  it('renders an error with the ✗ marker and indented suggestion', () => {
    const out = textOf({ type: 'error', message: 'boom', suggestion: 'try --help', exitCode: 1 });
    expect(out).toBe('  ✗ boom\n      try --help');
  });

  it('renders an error without a suggestion', () => {
    const out = textOf({ type: 'error', message: 'boom', exitCode: 1 });
    expect(out).toBe('  ✗ boom');
  });

  const simBase: SimDoneResult = {
    type: 'sim-done',
    recipeName: 'example',
    cwd: '/x',
    totalScenarios: 2,
    passedScenarios: 1,
    failedScenarios: 1,
    durationMs: 1500,
    scenarios: [
      { scenarioId: 'a', scenarioName: 'loads ok', kind: 'load', passed: true, durationMs: 10 },
      { scenarioId: 'b', scenarioName: 'invariant', kind: 'invariant', passed: false, durationMs: 20, error: 'broke' },
    ],
  };

  it('renders the sim-done header, scenarios, and summary as plain text', () => {
    const out = textOf(simBase);
    expect(out).toContain('  Simulation');
    expect(out).toContain('  Recipe: example');
    expect(out).toContain('✓ loads ok (load, 10ms)');
    expect(out).toContain('✗ invariant (invariant, 20ms)');
    expect(out).toContain('broke');
    expect(out).toContain('1 passed, 1 failed | Duration 1.5s');
  });

  it('renders the empty-scenarios sim-done shape', () => {
    const out = textOf({ ...simBase, scenarios: [], totalScenarios: 0, passedScenarios: 0, failedScenarios: 0 });
    expect(out).toContain("No scenarios matched recipe 'example'");
  });

  it('renders graph-done summary + footer via the shared producers (no banner text)', () => {
    const out = textOf({
      type: 'graph-done',
      reportLines: [],
      summary: { passed: 3, failed: 0, errors: 0, warnings: 0 },
      durationMs: 1200,
      footerHints: [{ text: 'Use --verbose for detailed results', bold: ['--verbose'] }],
    });
    expect(out).toContain('3 Passed, 0 Failed (0 Errors, 0 Warnings) | Duration 1.2s');
    expect(out).toContain('  Use --verbose for detailed results');
  });

  it('renders gate-done lines verbatim', () => {
    const out = textOf({
      type: 'gate-done',
      lines: ['opensip-tools gate compare', '', '✓ STABLE — no change'],
    });
    expect(out).toBe('opensip-tools gate compare\n\n✓ STABLE — no change');
  });

  it('renders the graph-done verbose body and fast-tier caveat', () => {
    const out = textOf({
      type: 'graph-done',
      reportLines: ['== Catalog ==', '5 functions across 2 files (cacheHit=false)'],
      resolutionBanner: 'Resolution: fast (syntactic) — edges are approximate.',
      summary: { passed: 1, failed: 1, errors: 0, warnings: 0 },
      durationMs: 50,
      footerHints: [],
    });
    expect(out).toContain('== Catalog ==');
    expect(out).toContain('5 functions across 2 files');
    expect(out).toContain('Resolution: fast (syntactic)');
    expect(out).toContain('1 Passed, 1 Failed');
  });
});
