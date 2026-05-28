/**
 * Smoke tests for the SARIF renderer's public re-export shape.
 *
 * Phase 2 Task 2.2 (DEC-498): the prior test suite asserted the
 * fitness-shim wrapper's behavior against a `CliOutput` input shape.
 * That shape no longer applies — `render/sarif.ts` now re-exports
 * `renderSarifOpenSip` (which takes `Signal[]` + context) as
 * `renderSarif`. This file keeps a thin smoke test on the re-export
 * shape; comprehensive per-rule golden fixtures live in
 * `sarif-opensip.test.ts` (Task 2.3).
 */

import { describe, expect, it } from 'vitest';

import { renderSarif } from '../../render/sarif.js';

import type { Signal } from '@opensip-tools/core';

const CONTEXT = { tool: 'opensip-tools-graph', toolVersion: '2.0.0' };

function makeSignal(overrides: Partial<Signal> = {}): Signal {
  return {
    id: 'sig_test',
    source: 'graph',
    provider: 'opensip-tools',
    severity: 'medium',
    category: 'quality',
    ruleId: 'graph:orphan-subtree',
    message: 'test',
    filePath: 'src/foo.ts',
    metadata: {},
    createdAt: '2026-05-27T00:00:00.000Z',
    ...overrides,
  };
}

describe('renderSarif (re-export of renderSarifOpenSip)', () => {
  it('produces a SARIF v2.1.0 log with one run', () => {
    const sarif = renderSarif([], CONTEXT);
    const parsed = JSON.parse(sarif) as { version: string; runs: unknown[] };
    expect(parsed.version).toBe('2.1.0');
    expect(parsed.runs).toHaveLength(1);
  });

  it('emits OpenSIP-convention rule IDs on results', () => {
    const sarif = renderSarif([makeSignal()], CONTEXT);
    const parsed = JSON.parse(sarif) as {
      runs: Array<{ results: Array<{ ruleId: string }> }>;
    };
    expect(parsed.runs[0]!.results[0]!.ruleId).toBe('graph.dead-code.orphan-subtree');
  });

  it('sets tool.driver.name and version from context', () => {
    const sarif = renderSarif([], CONTEXT);
    const parsed = JSON.parse(sarif) as {
      runs: Array<{ tool: { driver: { name: string; version: string } } }>;
    };
    expect(parsed.runs[0]!.tool.driver.name).toBe('opensip-tools-graph');
    expect(parsed.runs[0]!.tool.driver.version).toBe('2.0.0');
  });
});
