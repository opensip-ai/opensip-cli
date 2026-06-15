/**
 * Tests for `buildGraphEnvelope` (ADR-0011 Phase 5) — the graph run's signal
 * envelope assembly. Covers the Option-A rule-ID mapping (engine slug →
 * OpenSIP rule ID on both `ruleId` and `source`), per-rule unit derivation,
 * the verdict counts, and `resolutionMode` passthrough.
 */

import { describe, expect, it } from 'vitest';

import { buildGraphEnvelope } from '../build-envelope.js';

import type { Signal } from '@opensip-cli/core';

function signal(over: Partial<Signal> = {}): Signal {
  return {
    id: 'sig_1',
    source: 'graph',
    provider: 'opensip-cli',
    severity: 'medium',
    category: 'quality',
    ruleId: 'graph:orphan-subtree',
    message: 'msg',
    filePath: 'src/a.ts',
    line: 1,
    metadata: {},
    createdAt: '2026-06-04T00:00:00.000Z',
    ...over,
  };
}

const BASE = { runId: 'run-1', createdAt: '2026-06-04T00:00:00.000Z' };

describe('buildGraphEnvelope', () => {
  it('maps engine slug → OpenSIP rule ID on both ruleId and source', () => {
    const env = buildGraphEnvelope({ ...BASE, signals: [signal()] });
    expect(env.signals[0]?.ruleId).toBe('graph.dead-code.orphan-subtree');
    expect(env.signals[0]?.source).toBe('graph.dead-code.orphan-subtree');
  });

  it('derives one unit per rule that fired, keyed on the mapped slug', () => {
    const env = buildGraphEnvelope({
      ...BASE,
      signals: [
        signal({ ruleId: 'graph:orphan-subtree' }),
        signal({ ruleId: 'graph:orphan-subtree' }),
        signal({ ruleId: 'graph:cycle', severity: 'high' }),
      ],
    });
    const slugs = env.units.map((u) => u.slug).sort();
    expect(slugs).toEqual(['graph.architecture.cycle', 'graph.dead-code.orphan-subtree']);
    const orphan = env.units.find((u) => u.slug === 'graph.dead-code.orphan-subtree');
    expect(orphan?.violationCount).toBe(2);
    expect(orphan?.passed).toBe(true); // medium severity ⇒ no error
    const cycle = env.units.find((u) => u.slug === 'graph.architecture.cycle');
    expect(cycle?.passed).toBe(false); // high severity ⇒ error ⇒ fail
  });

  it('computes the verdict (errors = critical|high; passed ⇔ errors === 0)', () => {
    const clean = buildGraphEnvelope({ ...BASE, signals: [signal({ severity: 'low' })] });
    expect(clean.verdict.passed).toBe(true);
    expect(clean.verdict.summary.errors).toBe(0);
    expect(clean.verdict.summary.warnings).toBe(1);

    const failing = buildGraphEnvelope({ ...BASE, signals: [signal({ severity: 'critical' })] });
    expect(failing.verdict.passed).toBe(false);
    expect(failing.verdict.summary.errors).toBe(1);
  });

  it('is schemaVersion 2 and tool graph, with an empty units list for no signals', () => {
    const env = buildGraphEnvelope({ ...BASE, signals: [] });
    expect(env.schemaVersion).toBe(2);
    expect(env.tool).toBe('graph');
    expect(env.units).toEqual([]);
    expect(env.verdict.passed).toBe(true);
  });

  it('passes resolutionMode through only when set', () => {
    expect(buildGraphEnvelope({ ...BASE, signals: [] }).resolutionMode).toBeUndefined();
    expect(
      buildGraphEnvelope({ ...BASE, signals: [], resolutionMode: 'fast' }).resolutionMode,
    ).toBe('fast');
  });
});
