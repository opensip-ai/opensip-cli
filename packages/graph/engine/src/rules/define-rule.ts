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
 * **Forward-compat with Plan C.** The dataset object carries an optional
 * `features?` slot, **absent/undefined in Plan B**. Plan C populates it;
 * Plan D rules read it. Plan B only fixes the shape so neither needs
 * another contract churn. `GraphFeatures` is an intentional empty
 * placeholder here — do NOT add real columns (spec Boundaries).
 */

import { ValidationError } from '@opensip-tools/core';

import type { Catalog, GraphConfig, Indexes, Rule, RuleHints } from '../types.js';
import type { Signal } from '@opensip-tools/core';

/**
 * Forward-compat placeholder for the engine-computed feature columns Plan C
 * will attach to the dataset. **Empty in Plan B** — left `undefined` at
 * runtime. Plan C populates real fields; do not add columns here.
 */
export type GraphFeatures = Record<string, never>;

/**
 * The dataset object handed to a `defineRule` author's `evaluate`. Parallels
 * `defineCheck`'s `(content, filePath)`: "give the author the data." Object
 * form is extensible — Plan C adds `features` with no signature churn.
 */
export interface RuleDataset {
  readonly catalog: Catalog;
  readonly indexes: Indexes;
  readonly config: GraphConfig;
  readonly hints?: RuleHints;
  readonly features?: GraphFeatures;
}

/** Author-facing config for `defineRule`. */
export interface DefineRuleConfig {
  /** Rule slug, e.g. "graph:orphan-subtree". Must start with "graph:". */
  readonly slug: string;
  readonly defaultSeverity: 'error' | 'warning';
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
    evaluate(catalog: Catalog, indexes: Indexes, ruleConfig: GraphConfig, hints?: RuleHints): readonly Signal[] {
      // `features` omitted ⇒ undefined in Plan B (Plan C populates it).
      return config.evaluate({ catalog, indexes, config: ruleConfig, hints });
    },
  };
  return Object.freeze(rule);
}
