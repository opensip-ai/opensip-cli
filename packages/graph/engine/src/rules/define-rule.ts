/**
 * `defineRule` — ergonomic factory wrapping the existing `Rule` interface.
 *
 * Mirrors fitness's `defineCheck`: the author writes a single
 * `evaluate(data)` taking a dataset object `{ catalog, indexes, config,
 * hints?, features? }` instead of the legacy positional
 * `(catalog, indexes, config, hints?)` signature. The factory validates
 * metadata, freezes the result, and adapts the object form back to the
 * positional `Rule.evaluate` the orchestrator calls
 * (`orchestrate.ts:217`) — so the orchestrator, registry, and every
 * existing test stay untouched (the factory returns the *existing* `Rule`
 * interface; there is no `Rule2`).
 *
 * **Identity-preserving.** `defineRule` adds no behavior beyond the
 * positional→object adapter — slug / `ruleId` / emitted signals are
 * whatever the author's `evaluate` body produces, byte-for-byte.
 *
 * **Plan C — features populated.** The dataset object carries an optional
 * `features?` slot typed as the engine-computed `FeatureTable`. Plan C
 * populates it (via the orchestrator's features stage + the positional 5th
 * `evaluate` arg this factory now threads through); Plan D rules read it.
 * The slot is still optional so 3/4-arg test calls and the features-absent
 * fallback path stay valid.
 */

import { ValidationError } from '@opensip-tools/core';

import type { Catalog, FeatureColumn, FeatureTable, GraphConfig, Indexes, Rule, RuleHints } from '../types.js';
import type { Signal } from '@opensip-tools/core';

/**
 * The engine-computed feature columns attached to the dataset. Plan B
 * reserved this as an empty placeholder; Plan C points it at the real
 * {@link FeatureTable}. Retained as a named alias because it is on the
 * engine's public barrel.
 */
export type GraphFeatures = FeatureTable;

/**
 * The dataset object handed to a `defineRule` author's `evaluate`. Parallels
 * `defineCheck`'s `(content, filePath)`: "give the author the data." Object
 * form is extensible — Plan C populates `features` with no signature churn.
 */
export interface RuleDataset {
  readonly catalog: Catalog;
  readonly indexes: Indexes;
  readonly config: GraphConfig;
  readonly hints?: RuleHints;
  /** Engine-computed feature columns (Plan C). Present when the orchestrator
   *  ran the features stage; `undefined` for 3/4-arg test calls. */
  readonly features?: FeatureTable;
}

/** Author-facing config for `defineRule`. */
export interface DefineRuleConfig {
  /** Rule slug, e.g. "graph:orphan-subtree". Must start with "graph:". */
  readonly slug: string;
  readonly defaultSeverity: 'error' | 'warning';
  /**
   * Feature columns this rule reads. Surfaced onto the built `Rule` so the
   * orchestrator's `unionFeatureDeps` computes them (lazy/needed-only).
   */
  readonly featureDeps?: readonly FeatureColumn[];
  readonly evaluate: (data: RuleDataset) => readonly Signal[];
}

const VALIDATION_CODE = 'VALIDATION.GRAPH.RULE';

/**
 * Build a `Rule` from an author-facing config. Validates metadata, freezes,
 * and adapts the positional `evaluate(catalog, indexes, config, hints)`
 * call shape (the orchestrator boundary) to the dataset-object form the
 * author wrote. The adapter is the only behavioral code in the factory.
 */
export function defineRule(config: DefineRuleConfig): Rule {
  if (typeof config.slug !== 'string' || config.slug.length === 0 || !config.slug.startsWith('graph:')) {
    // @fitness-ignore-next-line result-pattern-consistency -- authoring-time programmer error: invalid rule metadata
    throw new ValidationError(`defineRule: 'slug' must be a non-empty string starting with 'graph:' (got ${JSON.stringify(config.slug)})`, {
      code: VALIDATION_CODE,
    });
  }
  if (config.defaultSeverity !== 'error' && config.defaultSeverity !== 'warning') {
    // @fitness-ignore-next-line result-pattern-consistency -- authoring-time programmer error: invalid rule metadata
    throw new ValidationError(`defineRule: 'defaultSeverity' must be 'error' or 'warning' (got ${JSON.stringify(config.defaultSeverity)})`, {
      code: VALIDATION_CODE,
    });
  }
  if (typeof config.evaluate !== 'function') {
    // @fitness-ignore-next-line result-pattern-consistency -- authoring-time programmer error: invalid rule metadata
    throw new ValidationError(`defineRule: 'evaluate' must be a function for rule '${config.slug}'`, {
      code: VALIDATION_CODE,
    });
  }

  const rule: Rule = {
    slug: config.slug,
    defaultSeverity: config.defaultSeverity,
    ...(config.featureDeps ? { featureDeps: config.featureDeps } : {}),
    evaluate(
      catalog: Catalog,
      indexes: Indexes,
      ruleConfig: GraphConfig,
      hints?: RuleHints,
      features?: FeatureTable,
    ): readonly Signal[] {
      // The orchestrator threads the engine-computed FeatureTable as the 5th
      // positional arg (Plan C); `features` is undefined on 3/4-arg test calls.
      return config.evaluate({ catalog, indexes, config: ruleConfig, hints, features });
    },
  };
  return Object.freeze(rule);
}
