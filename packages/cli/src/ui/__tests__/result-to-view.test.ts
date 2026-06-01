import { renderToText } from '@opensip-tools/cli-ui';
import { describe, it, expect } from 'vitest';

import { resultToView } from '../result-to-view.js';

import type { CommandResult, SimDoneResult } from '@opensip-tools/contracts';

function textOf(result: CommandResult): string {
  const view = resultToView(result);
  if (view === null) throw new Error('expected a migrated view');
  return renderToText(view);
}

describe('resultToView', () => {
  it('returns null for not-yet-migrated result types', () => {
    expect(resultToView({ type: 'help' })).toBeNull();
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
