import { createSignal, HOST_VERDICT_POLICY_FALLBACK } from '@opensip-cli/core';
import { describe, expect, it } from 'vitest';

import {
  AgentFilterParseError,
  applyAgentFilters,
  normalizeAgentRunFilters,
} from '../agent-filters.js';
import { buildSignalEnvelope } from '../signal-envelope.js';

function envelope(signals: ReturnType<typeof createSignal>[]) {
  return buildSignalEnvelope({
    tool: 'fit',
    signals,
    units: [{ slug: 'unit-a', passed: true, durationMs: 1 }],
    runId: 'RUN_test',
    createdAt: '2026-01-01T00:00:00.000Z',
    policy: HOST_VERDICT_POLICY_FALLBACK,
    runFaulted: false,
  });
}

describe('applyAgentFilters', () => {
  const env = envelope([
    createSignal({
      source: 'fit',
      ruleId: 'a',
      severity: 'critical',
      message: 'crit',
      code: { file: 'src/a.ts' },
      category: 'security',
    }),
    createSignal({
      source: 'fit',
      ruleId: 'b',
      severity: 'high',
      message: 'high',
      code: { file: 'src/b.ts' },
      category: 'quality',
    }),
    createSignal({
      source: 'fit',
      ruleId: 'c',
      severity: 'medium',
      message: 'med',
      code: { file: 'src/c.ts' },
    }),
    createSignal({
      source: 'graph',
      ruleId: 'd',
      severity: 'high',
      message: 'blast',
      metadata: { highImpact: true, blast: 25 },
      code: { file: 'src/d.ts' },
    }),
  ]);

  it('errors-only keeps critical and high', () => {
    const r = applyAgentFilters(env, ['errors-only']);
    expect(r.returnedSignalCount).toBe(3);
    expect(
      r.envelope.signals.every((s) => s.severity === 'critical' || s.severity === 'high'),
    ).toBe(true);
  });

  it('warnings-only keeps medium and low', () => {
    const r = applyAgentFilters(env, ['warnings-only']);
    expect(r.returnedSignalCount).toBe(1);
    expect(r.envelope.signals[0]?.severity).toBe('medium');
  });

  it('category and source filters select correctly', () => {
    expect(applyAgentFilters(env, ['category:security']).returnedSignalCount).toBe(1);
    expect(applyAgentFilters(env, ['source:graph']).returnedSignalCount).toBe(1);
  });

  it('file prefix and high-impact filters work', () => {
    expect(applyAgentFilters(env, ['file:src/a']).returnedSignalCount).toBe(1);
    expect(applyAgentFilters(env, ['high-impact']).returnedSignalCount).toBe(1);
  });

  it('top:N limits after other predicates', () => {
    const r = applyAgentFilters(env, ['errors-only', 'top:1']);
    expect(r.returnedSignalCount).toBe(1);
  });

  it('normalizeAgentRunFilters folds --top', () => {
    expect(normalizeAgentRunFilters([], '5')).toEqual(['top:5']);
  });

  it('rejects unknown tokens and invalid top', () => {
    expect(() => applyAgentFilters(env, ['bogus'])).toThrow(AgentFilterParseError);
    expect(() => normalizeAgentRunFilters([], '-1')).toThrow(AgentFilterParseError);
    expect(() => normalizeAgentRunFilters([], 'abc')).toThrow(AgentFilterParseError);
  });
});
