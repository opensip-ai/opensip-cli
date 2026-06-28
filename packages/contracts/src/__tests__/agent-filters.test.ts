import { createSignal, HOST_VERDICT_POLICY_FALLBACK } from '@opensip-cli/core';
import { describe, expect, it } from 'vitest';

import {
  AgentFilterParseError,
  agentRunFlagSpecs,
  applyAgentFilters,
  buildAgentFilteredResult,
  normalizeAgentRunFilters,
} from '../agent-filters.js';
import { EXIT_CODES, mapToolErrorToExitCode } from '../exit-codes.js';
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

  it('returns the original envelope when no filters are requested', () => {
    const r = applyAgentFilters(env, []);
    expect(r.envelope).toBe(env);
    expect(r.filtersApplied).toEqual([]);
    expect(r.originalSignalCount).toBe(4);
    expect(r.returnedSignalCount).toBe(4);
  });

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

  it('high-impact accepts structured blast scores at the shared threshold', () => {
    const blastEnv = envelope([
      createSignal({
        source: 'graph',
        ruleId: 'blast-object',
        severity: 'medium',
        message: 'blast object',
        metadata: { blast: { score: 10 } },
        code: { file: 'src/blast.ts' },
      }),
      createSignal({
        source: 'graph',
        ruleId: 'below-threshold',
        severity: 'medium',
        message: 'below threshold',
        metadata: { blast: { score: 9 } },
        code: { file: 'src/below.ts' },
      }),
      createSignal({
        source: 'graph',
        ruleId: 'non-object',
        severity: 'medium',
        message: 'non object',
        metadata: { blast: null },
        code: { file: 'src/none.ts' },
      }),
    ]);

    const r = applyAgentFilters(blastEnv, ['high-impact']);
    expect(r.envelope.signals.map((s) => s.ruleId)).toEqual(['blast-object']);
  });

  it('top:N limits after other predicates', () => {
    const r = applyAgentFilters(env, ['errors-only', 'top:1']);
    expect(r.returnedSignalCount).toBe(1);
  });

  it('top:N sorts by severity rank while preserving original order for ties', () => {
    const r = applyAgentFilters(env, ['top:3']);
    expect(r.envelope.signals.map((s) => s.ruleId)).toEqual(['a', 'b', 'd']);
  });

  it('builds the machine-result wrapper around a filtered envelope', () => {
    const r = buildAgentFilteredResult(env, ['category:security']);
    expect(r).toMatchObject({
      type: 'agent-filtered',
      filtersApplied: ['category:security'],
      originalSignalCount: 4,
      returnedSignalCount: 1,
    });
    expect(r.envelope.signals[0]?.ruleId).toBe('a');
  });

  it('normalizeAgentRunFilters folds --top', () => {
    expect(normalizeAgentRunFilters([], '5')).toEqual(['top:5']);
  });

  it('rejects unknown tokens and invalid top', () => {
    expect(() => applyAgentFilters(env, ['bogus'])).toThrow(AgentFilterParseError);
    for (const token of ['', ' ', 'category:', 'source:', 'file:', 'top:']) {
      expect(() => applyAgentFilters(env, [token])).toThrow(AgentFilterParseError);
    }
    expect(() => normalizeAgentRunFilters([], '-1')).toThrow(AgentFilterParseError);
    expect(() => normalizeAgentRunFilters([], 'abc')).toThrow(AgentFilterParseError);
  });

  it('declares the repeatable --filter parser used by live-run command specs', () => {
    const spec = agentRunFlagSpecs.find((option) => option.flag === '--filter');
    expect(spec?.arrayDefault).toEqual([]);
    expect(spec?.parse?.('errors-only', [])).toEqual(['errors-only']);
    expect(spec?.parse?.('top:5', ['errors-only'])).toEqual(['errors-only', 'top:5']);
  });

  it('maps a bad live-run filter to the CONFIGURATION_ERROR exit code', () => {
    // AgentFilterParseError extends ConfigurationError so the host error
    // boundary exits 2 on a malformed --filter/--top, matching `graph impact`.
    let caught: AgentFilterParseError | undefined;
    try {
      normalizeAgentRunFilters([], 'abc');
    } catch (error) {
      if (error instanceof AgentFilterParseError) caught = error;
    }
    expect(caught).toBeInstanceOf(AgentFilterParseError);
    expect(mapToolErrorToExitCode(caught!)).toBe(EXIT_CODES.CONFIGURATION_ERROR);
  });
});
