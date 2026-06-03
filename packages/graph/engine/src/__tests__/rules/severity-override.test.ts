/**
 * Severity-override clamp — opt-in and baseline-neutral (ADR-0005).
 *
 * Unit-tests `applySeverityOverride` (the no-op path for every severity when
 * unset; clamps to high/medium when set) plus an integration check that a
 * ported rule (orphan-subtree, base medium) and a new rule (large-function,
 * base high) emit their hardcoded base with `{}` config and clamp when an
 * override is set for that slug.
 */

import { describe, expect, it } from 'vitest';

import { buildIndexes } from '../../pipeline/indexes.js';
import { applySeverityOverride } from '../../rules/_severity-override.js';
import { largeFunctionRule } from '../../rules/large-function.js';
import { orphanSubtreeRule } from '../../rules/orphan-subtree.js';

import { makeCatalog, occ } from './_helpers.js';

import type { GraphConfig } from '../../types.js';
import type { SignalSeverity } from '@opensip-tools/core';

const ALL_SEVERITIES: readonly SignalSeverity[] = ['critical', 'high', 'medium', 'low'];

describe('applySeverityOverride', () => {
  it('is a no-op for every severity when no override is configured', () => {
    for (const base of ALL_SEVERITIES) {
      expect(applySeverityOverride(base, 'graph:any', {})).toBe(base);
    }
  });

  it("clamps 'error' → 'high' and 'warning' → 'medium' when set for the slug", () => {
    const errCfg: GraphConfig = { severityOverrides: { 'graph:x': 'error' } };
    const warnCfg: GraphConfig = { severityOverrides: { 'graph:x': 'warning' } };
    expect(applySeverityOverride('low', 'graph:x', errCfg)).toBe('high');
    expect(applySeverityOverride('low', 'graph:x', warnCfg)).toBe('medium');
  });

  it('leaves the base unchanged when the override targets a different slug', () => {
    const cfg: GraphConfig = { severityOverrides: { 'graph:other': 'error' } };
    const base: SignalSeverity = 'medium';
    expect(applySeverityOverride(base, 'graph:x', cfg)).toBe('medium');
  });
});

describe('clamp integration — baseline-neutral when unset, clamps when set', () => {
  it('orphan-subtree (base medium) is unchanged with {} and clamps when overridden', () => {
    const orphan = occ({ bodyHash: 'o', simpleName: 'lonely', visibility: 'module-local' });
    const catalog = makeCatalog([orphan]);
    const indexes = buildIndexes(catalog);

    const baseSignals = orphanSubtreeRule.evaluate(catalog, indexes, {});
    expect(baseSignals.some((s) => s.message.includes('lonely'))).toBe(true);
    for (const s of baseSignals) expect(s.severity).toBe('medium');

    const clamped = orphanSubtreeRule.evaluate(catalog, indexes, {
      severityOverrides: { 'graph:orphan-subtree': 'error' },
    });
    for (const s of clamped) expect(s.severity).toBe('high');
  });

  it('large-function (base high) is unchanged without an override and clamps when set', () => {
    const big = occ({ bodyHash: 'h', simpleName: 'huge', line: 1, endLine: 200 });
    const catalog = makeCatalog([big]);
    const indexes = buildIndexes(catalog);
    // Explicit thresholds (error 150) so the 200-line span is base `high`
    // regardless of the shipped defaults — this case tests the clamp, not the bands.
    const bands: GraphConfig = { largeFunctionWarnLines: 80, largeFunctionErrorLines: 150 };

    const baseSignals = largeFunctionRule.evaluate(catalog, indexes, bands);
    expect(baseSignals).toHaveLength(1);
    expect(baseSignals[0]?.severity).toBe('high');

    const clamped = largeFunctionRule.evaluate(catalog, indexes, {
      ...bands,
      severityOverrides: { 'graph:large-function': 'warning' },
    });
    expect(clamped[0]?.severity).toBe('medium');
  });
});
