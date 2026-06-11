/**
 * Shared, fully-deterministic {@link SignalEnvelope} fixtures for the
 * pure-formatter snapshot tests. Fixed ids/timestamps (no `randomUUID`/
 * `Date.now()`) so a fixed envelope renders to a fixed string with zero mocks
 * (formatter-purity contract, ADR-0011).
 */
import type { SignalEnvelope } from '@opensip-tools/contracts';
import type { Signal } from '@opensip-tools/core';

function signal(overrides: Partial<Signal>): Signal {
  return {
    id: 'sig_fixture0001',
    source: 'graph:orphan-subtree',
    provider: 'opensip-tools',
    severity: 'high',
    category: 'architecture',
    ruleId: 'graph:orphan-subtree',
    message: 'Unreachable function',
    filePath: 'src/foo.ts',
    line: 10,
    column: 3,
    code: { file: 'src/foo.ts', line: 10, column: 3 },
    metadata: {},
    createdAt: '2026-06-04T00:00:00.000Z',
    ...overrides,
  };
}

/** Two units (one passing-empty, one failing) across two signals. */
export const FIXTURE_ENVELOPE: SignalEnvelope = {
  schemaVersion: 2,
  tool: 'graph',
  recipe: 'example',
  runId: 'run_fixture0001',
  createdAt: '2026-06-04T00:00:00.000Z',
  verdict: {
    score: 50,
    passed: false,
    summary: { total: 2, passed: 1, failed: 1, errors: 1, warnings: 1 },
  },
  units: [
    { slug: 'graph:orphan-subtree', passed: false, violationCount: 1, durationMs: 12 },
    { slug: 'graph:large-function', passed: true, violationCount: 1, durationMs: 7 },
  ],
  signals: [
    signal({}),
    signal({
      id: 'sig_fixture0002',
      source: 'graph:large-function',
      severity: 'medium',
      category: 'quality',
      ruleId: 'graph:large-function',
      message: 'Function too large',
      filePath: 'src/bar.ts',
      line: 42,
      column: 1,
      code: { file: 'src/bar.ts', line: 42, column: 1 },
    }),
  ],
};

/** Empty run — no units, no signals (the "ran, found nothing" shape). */
export const EMPTY_ENVELOPE: SignalEnvelope = {
  schemaVersion: 2,
  tool: 'fit',
  runId: 'run_fixture0002',
  createdAt: '2026-06-04T00:00:00.000Z',
  verdict: {
    score: 100,
    passed: true,
    summary: { total: 0, passed: 0, failed: 0, errors: 0, warnings: 0 },
  },
  units: [],
  signals: [],
};
