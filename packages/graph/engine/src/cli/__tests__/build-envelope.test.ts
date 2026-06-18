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

/**
 * Fingerprint byte-preservation (envelope-first-presentation RP-2, Task 2.4).
 *
 * The git-trackable graph fingerprint baseline (`graph-baseline-export` JSON) is
 * a consumer-repo artifact; ANY shift in a fingerprint silently breaks adopters'
 * ratchets (a stable finding reads as simultaneously "resolved" + "new"). RP-2
 * routes graph's RENDER path through the full-envelope `presentationToView`, but
 * fingerprints are stamped by `graphFingerprintStrategy`
 * (`ruleId|filePath|line|column`, keyed on the REMAPPED canonical ruleId via
 * Option A) at envelope construction — independent of envelope "fullness." This
 * fixture PROVES (not assumes) the stamped values are invariant: a committed
 * golden set the export serializes byte-for-byte. If any of these strings shift,
 * the render-path change leaked into the baseline key — STOP and investigate.
 */
describe('buildGraphEnvelope — fingerprint byte-preservation (RP-2 Task 2.4)', () => {
  // A fixed Signal[] fixture spanning three rule families (cross-family ruleId
  // remap), a missing column (→ default 0), and a run-varying message
  // (deliberately NOT in the key — see baseline-strategy.ts).
  const FIXTURE: Signal[] = [
    signal({
      ruleId: 'graph:cycle',
      severity: 'high',
      filePath: 'src/a.ts',
      line: 10,
      column: 4,
      message: 'cycle A→B→A',
    }),
    signal({
      ruleId: 'graph:orphan-subtree',
      severity: 'medium',
      filePath: 'src/b.ts',
      line: 22,
      column: undefined,
      message: 'orphan B',
    }),
    signal({
      ruleId: 'graph:duplicated-function-body',
      severity: 'low',
      filePath: 'src/c.ts',
      line: 5,
      column: 0,
      // Run-varying count in the message — MUST NOT enter the fingerprint.
      message: 'shares body with 3 other functions',
    }),
  ];

  // The committed golden fingerprints. Each is `ruleId|filePath|line|column` over
  // the REMAPPED canonical ruleId (Option A). Byte-preserved from before RP-2.
  const GOLDEN_FINGERPRINTS: readonly string[] = [
    'graph.architecture.cycle|src/a.ts|10|4',
    'graph.dead-code.orphan-subtree|src/b.ts|22|0',
    'graph.duplication.duplicated-function-body|src/c.ts|5|0',
  ];

  it('stamps each signal with the committed golden fingerprint (over the remapped ruleId)', () => {
    const env = buildGraphEnvelope({ ...BASE, signals: FIXTURE });
    expect(env.signals.map((s) => s.fingerprint)).toEqual(GOLDEN_FINGERPRINTS);
  });

  it('computes the fingerprint over the canonical (remapped) ruleId, not the engine slug', () => {
    const env = buildGraphEnvelope({ ...BASE, signals: FIXTURE });
    // The remapped ruleId leads each fingerprint; the engine slug `graph:*` must
    // never appear in the key (mapEngineSlugToOpenSipRuleId, Option A).
    for (const s of env.signals) {
      expect(s.fingerprint?.startsWith(`${s.ruleId}|`)).toBe(true);
      expect(s.fingerprint).not.toContain('graph:');
    }
  });

  it('excludes the run-varying message from the fingerprint (ratchet stability)', () => {
    // Same finding, different message (the duplicate-count text shifts run to run):
    // the fingerprint must be byte-identical so the gate does not flap.
    const a = buildGraphEnvelope({ ...BASE, signals: FIXTURE });
    const shiftedFixture = FIXTURE.map((s) =>
      s.ruleId === 'graph:duplicated-function-body'
        ? { ...s, message: 'shares body with 99 other functions' }
        : s,
    );
    const b = buildGraphEnvelope({ ...BASE, signals: shiftedFixture });
    expect(b.signals.map((s) => s.fingerprint)).toEqual(a.signals.map((s) => s.fingerprint));
    expect(b.signals.map((s) => s.fingerprint)).toEqual(GOLDEN_FINGERPRINTS);
  });
});
