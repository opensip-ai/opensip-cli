/**
 * @fileoverview Unit coverage for `defineRule` (Plan B, Phase 5 Task 5.2).
 *
 *  (a) the returned object satisfies the `Rule` interface;
 *  (b) `evaluate` is callable positionally `(catalog, indexes, config, hints)`
 *      — the orchestrator boundary — and the dataset object reaches the author;
 *  (c) the dataset's `features` slot is `undefined` on a 4-arg call and
 *      carries the threaded FeatureTable on a 5-arg call (Plan C);
 *  (d) invalid metadata (bad slug / bad defaultSeverity / non-function evaluate)
 *      throws `ValidationError`.
 */

import { ValidationError } from '@opensip-cli/core';
import { describe, expect, it } from 'vitest';

import { defineRule } from '../define-rule.js';

import type { Catalog, FeatureTable, GraphConfig, Indexes, RuleHints } from '../../types.js';
import type { RuleDataset } from '../define-rule.js';
import type { Signal } from '@opensip-cli/core';

const CATALOG = { functions: {} } as unknown as Catalog;
const INDEXES = { byBodyHash: new Map() } as unknown as Indexes;
const CONFIG: GraphConfig = {};

describe('defineRule', () => {
  it('returns an object satisfying the Rule interface', () => {
    const rule = defineRule({ slug: 'graph:demo', defaultSeverity: 'warning', evaluate: () => [] });
    expect(rule.slug).toBe('graph:demo');
    expect(rule.defaultSeverity).toBe('warning');
    expect(typeof rule.evaluate).toBe('function');
    expect(Object.isFrozen(rule)).toBe(true);
  });

  it('adapts the positional evaluate(catalog, indexes, config, hints) call to the dataset object', () => {
    let received: RuleDataset | undefined;
    const rule = defineRule({
      slug: 'graph:demo',
      defaultSeverity: 'warning',
      evaluate: (data) => {
        received = data;
        return [];
      },
    });
    const hints = { sideEffectPrimitives: ['print'] } as unknown as RuleHints;
    rule.evaluate(CATALOG, INDEXES, CONFIG, hints);
    expect(received?.catalog).toBe(CATALOG);
    expect(received?.indexes).toBe(INDEXES);
    expect(received?.config).toBe(CONFIG);
    expect(received?.hints).toBe(hints);
  });

  it('leaves the dataset features slot undefined on a 4-arg call', () => {
    let received: unknown;
    const rule = defineRule({
      slug: 'graph:demo',
      defaultSeverity: 'warning',
      evaluate: (data) => {
        received = data.features;
        return [];
      },
    });
    rule.evaluate(CATALOG, INDEXES, CONFIG, undefined);
    expect(received).toBeUndefined();
  });

  it('threads the positional 5th features arg into the dataset (Plan C)', () => {
    let received: FeatureTable | undefined;
    const rule = defineRule({
      slug: 'graph:demo',
      defaultSeverity: 'warning',
      featureDeps: ['bodyLines'],
      evaluate: (data) => {
        received = data.features;
        return [];
      },
    });
    const features: FeatureTable = {
      function: new Map([['h1', { bodyLines: 7 }]]),
      package: new Map(),
      scc: [],
      edge: [],
    };
    rule.evaluate(CATALOG, INDEXES, CONFIG, undefined, features);
    expect(received).toBe(features);
    expect(received?.function.get('h1')?.bodyLines).toBe(7);
    expect(rule.featureDeps).toEqual(['bodyLines']);
  });

  it('passes through the signals the author returns', () => {
    const sig = { ruleId: 'graph:demo' } as unknown as Signal;
    const rule = defineRule({
      slug: 'graph:demo',
      defaultSeverity: 'error',
      evaluate: () => [sig],
    });
    expect(rule.evaluate(CATALOG, INDEXES, CONFIG, undefined)).toEqual([sig]);
  });

  it('throws ValidationError on an invalid slug', () => {
    expect(() =>
      defineRule({ slug: 'demo', defaultSeverity: 'warning', evaluate: () => [] }),
    ).toThrow(ValidationError);
    expect(() => defineRule({ slug: '', defaultSeverity: 'warning', evaluate: () => [] })).toThrow(
      ValidationError,
    );
  });

  it('throws ValidationError on an invalid defaultSeverity', () => {
    expect(() =>
      defineRule({ slug: 'graph:demo', defaultSeverity: 'fatal' as 'error', evaluate: () => [] }),
    ).toThrow(ValidationError);
  });

  it('throws ValidationError when evaluate is not a function', () => {
    expect(() =>
      defineRule({
        slug: 'graph:demo',
        defaultSeverity: 'warning',
        evaluate: undefined as unknown as () => Signal[],
      }),
    ).toThrow(ValidationError);
  });
});
