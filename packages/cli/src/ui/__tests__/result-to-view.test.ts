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
});
