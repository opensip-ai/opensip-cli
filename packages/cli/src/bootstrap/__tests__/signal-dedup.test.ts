import { describe, expect, it } from 'vitest';

import { normalizeCommandResultForRender, normalizeSignalEnvelope } from '../signal-dedup.js';

import type { RunPresentation, SignalEnvelope } from '@opensip-cli/contracts';
import type { Signal } from '@opensip-cli/core';

function signal(input: Partial<Signal> & Pick<Signal, 'id' | 'source' | 'ruleId'>): Signal {
  return {
    id: input.id,
    source: input.source,
    provider: input.provider ?? 'opensip-cli',
    severity: input.severity ?? 'high',
    category: input.category ?? 'quality',
    ruleId: input.ruleId,
    message: input.message ?? 'same finding',
    filePath: input.filePath ?? input.code?.file ?? 'src/a.ts',
    line: input.line ?? input.code?.line ?? 10,
    column: input.column ?? input.code?.column ?? 1,
    code: input.code ?? {
      file: input.filePath ?? 'src/a.ts',
      line: input.line ?? 10,
      column: input.column ?? 1,
    },
    metadata: input.metadata ?? {},
    ...(input.fingerprint === undefined ? {} : { fingerprint: input.fingerprint }),
    createdAt: input.createdAt ?? '2026-06-04T00:00:00.000Z',
  };
}

function envelope(signals: readonly Signal[]): SignalEnvelope {
  return {
    schemaVersion: 2,
    tool: 'graph',
    runId: 'run_dedup0001',
    createdAt: '2026-06-04T00:00:00.000Z',
    verdict: {
      score: 0,
      passed: false,
      summary: { total: 2, passed: 0, failed: 2, errors: 2, warnings: 1 },
    },
    units: [
      {
        slug: 'graph:near-duplicate-function-body',
        passed: false,
        violationCount: 2,
        durationMs: 1,
      },
      { slug: 'graph:cycle', passed: false, violationCount: 1, durationMs: 1 },
    ],
    signals,
    baselineIdentity: {
      fingerprintStrategyId: 'test',
      fingerprintStrategyVersion: 1,
    },
  };
}

describe('normalizeSignalEnvelope', () => {
  it('dedupes conservative near-identity signals and recomputes counts', () => {
    const env = envelope([
      signal({
        id: 'sig_graph_a',
        source: 'graph:near-duplicate-function-body',
        ruleId: 'graph:near-duplicate-function-body',
        column: 4,
      }),
      signal({
        id: 'sig_graph_b',
        source: 'graph:near-duplicate-function-body',
        ruleId: 'graph:near-duplicate-function-body',
        column: 12,
      }),
      signal({
        id: 'sig_cycle',
        source: 'graph:cycle',
        ruleId: 'graph:cycle',
        severity: 'medium',
        message: 'cycle',
        filePath: 'src/b.ts',
        line: 20,
        column: 1,
      }),
    ]);

    const normalized = normalizeSignalEnvelope(env);

    expect(normalized).not.toBe(env);
    expect(normalized.signals.map((s) => s.id)).toEqual(['sig_graph_a', 'sig_cycle']);
    expect(normalized.verdict.summary).toEqual({
      total: 2,
      passed: 1,
      failed: 1,
      errors: 1,
      warnings: 1,
    });
    expect(normalized.verdict.passed).toBe(false);
    expect(normalized.verdict.score).toBe(50);
    expect(normalized.units.map((u) => [u.slug, u.passed, u.violationCount])).toEqual([
      ['graph:near-duplicate-function-body', false, 1],
      ['graph:cycle', true, 1],
    ]);
  });

  it('dedupes by fingerprint and keeps the stronger severity', () => {
    const env = envelope([
      signal({
        id: 'sig_low',
        source: 'rule-a',
        ruleId: 'rule-a',
        severity: 'low',
        message: 'first finding shape',
        filePath: 'src/first.ts',
        line: 1,
        column: 1,
        fingerprint: 'same-fingerprint',
      }),
      signal({
        id: 'sig_high',
        source: 'rule-a',
        ruleId: 'rule-a',
        severity: 'high',
        message: 'second finding shape',
        filePath: 'src/second.ts',
        line: 99,
        column: 9,
        fingerprint: 'same-fingerprint',
      }),
    ]);

    const normalized = normalizeSignalEnvelope(env);

    expect(normalized.signals).toHaveLength(1);
    expect(normalized.signals[0]?.id).toBe('sig_high');
    expect(normalized.verdict.summary.errors).toBe(1);
    expect(normalized.verdict.summary.warnings).toBe(0);
  });

  it('does not collapse opaque fingerprint collisions across different sources', () => {
    const env = envelope([
      signal({
        id: 'sig_rule_a',
        source: 'rule-a',
        ruleId: 'rule-a',
        message: 'rule a finding',
        filePath: 'src/a.ts',
        fingerprint: 'same-opaque-value',
      }),
      signal({
        id: 'sig_rule_b',
        source: 'rule-b',
        ruleId: 'rule-b',
        message: 'rule b finding',
        filePath: 'src/b.ts',
        fingerprint: 'same-opaque-value',
      }),
    ]);

    expect(normalizeSignalEnvelope(env)).toBe(env);
  });

  it('returns the original object when no duplicates are found', () => {
    const env = envelope([
      signal({ id: 'sig_a', source: 'rule-a', ruleId: 'rule-a' }),
      signal({
        id: 'sig_b',
        source: 'rule-b',
        ruleId: 'rule-b',
        filePath: 'src/b.ts',
      }),
    ]);

    expect(normalizeSignalEnvelope(env)).toBe(env);
  });

  it('leaves malformed runtime values untouched at the host boundary', () => {
    const malformed = null as unknown as SignalEnvelope;

    expect(normalizeSignalEnvelope(malformed)).toBeNull();
  });
});

describe('normalizeCommandResultForRender', () => {
  it('normalizes the envelope carried by a RunPresentation', () => {
    const env = envelope([
      signal({ id: 'sig_a', source: 'rule-a', ruleId: 'rule-a' }),
      signal({ id: 'sig_b', source: 'rule-a', ruleId: 'rule-a', column: 9 }),
    ]);
    const result: RunPresentation = {
      type: 'run-presentation',
      tool: 'graph',
      envelope: env,
    };

    const normalized = normalizeCommandResultForRender(result) as RunPresentation;

    expect(normalized).not.toBe(result);
    expect(normalized.envelope.signals).toHaveLength(1);
    expect(result.envelope.signals).toHaveLength(2);
  });
});
