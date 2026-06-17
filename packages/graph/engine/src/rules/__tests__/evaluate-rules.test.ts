/**
 * evaluate-rules — the single rule-evaluation seam shared by both build
 * engines. These tests pin the two contracts that matter:
 *
 *  1. **Order preservation** — signals are appended in rule registration
 *     order, byte-for-byte as the prior inline loops produced them. Signal
 *     array order is observable downstream (fingerprint de-dup, SARIF), so
 *     this must never regress (e.g. via accidental parallelism).
 *  2. **Per-rule telemetry** — one `graph.rule.evaluated` debug event per
 *     rule, plus a `graph.rule.slow` WARN when a single rule both takes real
 *     wall-time AND owns the majority of the stage (the regression alarm that
 *     would have made an O(N²) rule visible immediately).
 */

import { logger, type Signal } from '@opensip-cli/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createGraphSignal } from '../create-graph-signal.js';
import { evaluateRules } from '../evaluate-rules.js';

import type { Catalog, GraphConfig, Indexes, Rule } from '../../types.js';

const CONFIG = {} as GraphConfig;

const CATALOG: Catalog = {
  version: '3.0',
  tool: 'graph',
  language: 'typescript',
  builtAt: '',
  cacheKey: '',
  functions: {},
};

const INDEXES: Indexes = {
  byBodyHash: new Map(),
  byOccId: new Map(),
  occurrencesByHash: new Map(),
  importedPackagesByFile: new Map(),
  bySimpleName: new Map(),
  callees: new Map(),
  callers: new Map(),
};

function sig(slug: string, message: string): Signal {
  return createGraphSignal(slug, CONFIG, { severity: 'low', category: 'quality', message });
}

/** A rule whose `evaluate` returns a fixed signal list (ignores its inputs). */
function fakeRule(slug: string, signals: readonly Signal[]): Rule {
  return { slug, defaultSeverity: 'warning', evaluate: () => signals };
}

function slowEvents(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown>[] {
  return spy.mock.calls
    .map((c: readonly unknown[]) => c[0])
    .filter(
      (o: unknown): o is Record<string, unknown> =>
        typeof o === 'object' && o !== null && (o as { evt?: string }).evt === 'graph.rule.slow',
    );
}

describe('evaluateRules', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('appends signals in rule registration order', () => {
    const a = sig('graph:a', 'a');
    const b1 = sig('graph:b', 'b1');
    const b2 = sig('graph:b', 'b2');
    const c = sig('graph:c', 'c');
    const rules = [
      fakeRule('graph:a', [a]),
      fakeRule('graph:b', [b1, b2]),
      fakeRule('graph:c', [c]),
    ];

    const out = evaluateRules(rules, { catalog: CATALOG, indexes: INDEXES, config: CONFIG });

    expect(out).toEqual([a, b1, b2, c]);
  });

  it('emits one graph.rule.evaluated debug event per rule, in order', () => {
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);

    evaluateRules([fakeRule('graph:a', []), fakeRule('graph:b', [])], {
      catalog: CATALOG,
      indexes: INDEXES,
      config: CONFIG,
    });

    const evaluated = debugSpy.mock.calls
      .map((c) => c[0])
      .filter(
        (o): o is Record<string, unknown> =>
          typeof o === 'object' &&
          o !== null &&
          (o as { evt?: string }).evt === 'graph.rule.evaluated',
      );
    expect(evaluated.map((e) => e.rule)).toEqual(['graph:a', 'graph:b']);
    expect(evaluated.every((e) => typeof e.durationMs === 'number')).toBe(true);
  });

  it('WARNs graph.rule.slow when one rule dominates a non-trivial stage', () => {
    // performance.now() is called start/end per rule: rule1 = 1000ms,
    // rule2 = 50ms, stage = 1050ms → rule1 is 95% of the stage and over the
    // 750ms floor, so it alarms; rule2 does not.
    vi.spyOn(performance, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(1000)
      .mockReturnValueOnce(1000)
      .mockReturnValueOnce(1050);
    vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    evaluateRules([fakeRule('graph:slow', []), fakeRule('graph:fast', [])], {
      catalog: CATALOG,
      indexes: INDEXES,
      config: CONFIG,
    });

    const slow = slowEvents(warnSpy);
    expect(slow).toHaveLength(1);
    expect(slow[0]?.rule).toBe('graph:slow');
    expect(slow[0]?.sharePct).toBeGreaterThanOrEqual(90);
  });

  it('does not WARN when the rules stage is fast', () => {
    // rule1 = 100ms, rule2 = 50ms, stage = 150ms — under the 750ms floor.
    vi.spyOn(performance, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(150);
    vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    evaluateRules([fakeRule('graph:a', []), fakeRule('graph:b', [])], {
      catalog: CATALOG,
      indexes: INDEXES,
      config: CONFIG,
    });

    expect(slowEvents(warnSpy)).toHaveLength(0);
  });
});
