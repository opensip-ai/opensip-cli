import type { Catalog, Indexes } from './call-graph.js';
import type { GraphConfig } from './config.js';
import type { FeatureColumn, FeatureTable } from './features.js';
import type { Signal } from '@opensip-cli/core';

/**
 * `RuleHints` — adapter-supplied per-language rule input. Historically
 * declared in `lang-adapter/types.ts` and re-exported here so rule
 * modules under `rules/` could consult hints without importing from
 * `lang-adapter/`. Keeping the type in the engine's shared type layer preserves
 * that direction after the old in-package `lang-*` directory rules were retired.
 *
 * The original re-export created a `types.ts ↔ lang-adapter/types.ts`
 * file-level cycle reported by `circular-import-detection`. The fix is
 * to host the canonical declaration here in the shared type layer (which sits
 * at the bottom of the engine's type layer) and have `lang-adapter/types.ts`
 * import it from here — inverting the dependency so the cycle is gone.
 */
export interface RuleHints {
  /** Predicate: is this file a test? Path is project-relative. */
  readonly isTestFile?: (filePathProjectRel: string) => boolean;
  /** Globs treated as generated code. */
  readonly generatedFilePatterns?: readonly string[];
  /** Side-effect primitives — fully-qualified names (e.g. 'fs.writeFileSync'). */
  readonly sideEffectPrimitives?: readonly string[];
  /** Throw-statement detection regex for `always-throws-branch`. */
  readonly throwSyntaxRegex?: RegExp;
}

/**
 * A rule consumes frozen catalog/indexes/config and returns Signals.
 *
 * The fourth parameter `hints` carries the active language adapter's
 * `RuleHints` (side-effect primitives, throw-syntax regex, test-file
 * predicate, generated-file globs). It is optional so test code may
 * still invoke `rule.evaluate(catalog, indexes, config)` without
 * threading hints through. Rules that don't need hints can ignore it;
 * rules that do consult hints MUST also implement a TypeScript-shaped
 * fallback so the rule degrades gracefully when an adapter does not
 * supply the relevant hint (per the graph rules-and-gating fidelity
 * matrix).
 *
 * The fifth parameter `features` (Plan C) carries the engine-computed
 * `FeatureTable` — the columns a rule declares via `featureDeps`. Like
 * `hints`, it is optional so test code may call `rule.evaluate(catalog,
 * indexes, config)` (3-arg) or `(…, hints)` (4-arg) without threading
 * features. A rule that reads a column MUST degrade gracefully (recompute
 * locally) when `features` is absent.
 */
export interface Rule {
  /** Rule slug, e.g. "graph:orphan-subtree". Must start with "graph:". */
  readonly slug: string;
  readonly defaultSeverity: 'error' | 'warning';
  /**
   * Feature columns this rule reads. The features stage computes the UNION
   * of every enabled rule's deps (+ the caller's `emitFeatures`) and nothing
   * else — lazy/needed-only. Absent ⇒ this rule reads no features.
   */
  readonly featureDeps?: readonly FeatureColumn[];
  readonly evaluate: (
    catalog: Catalog,
    indexes: Indexes,
    config: GraphConfig,
    hints?: RuleHints,
    features?: FeatureTable,
  ) => readonly Signal[];
}
