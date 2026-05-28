// @fitness-ignore-file unused-config-options -- FixEvaluationScenarioConfig is the public author-facing config schema for fix-evaluation scenarios; `criteriaMet`, `expectedDifficulty`, `signalIntent`, `expectedOutcome` are required scenario-metadata fields consumed by downstream analytics/dashboards, not by the engine's internal validation path.
/**
 * @fileoverview `FixEvaluationScenarioConfig` and predicate-composition
 * types — author-facing configuration.
 *
 * Extracted from `define.ts` into its own leaf module so `executor.ts`
 * can reference the config + predicate shapes without forming a
 * file-level cycle. See `../chaos/config.ts` for the same pattern.
 */

import type { CreateSignalInput } from '@opensip-tools/core';

// ============================================================================
// PREDICATE COMPOSITION TYPES
// ============================================================================

/** A leaf node in the predicate composition tree. */
export interface PredicateLeaf {
  readonly id: string;
  /** Inline arguments for the predicate (e.g. path/pattern for regex-in-file). */
  readonly [arg: string]: unknown;
}

/** Composition combinator for predicate trees. */
export interface PredicateComposition {
  readonly all_of?: readonly (PredicateComposition | PredicateLeaf)[];
  readonly any_of?: readonly (PredicateComposition | PredicateLeaf)[];
}

// ============================================================================
// SIGNAL PAYLOAD
// ============================================================================

/**
 * Signal payload the scenario emits. Aligned with `CreateSignalInput` from
 * `@opensip-tools/core` — the harness populates `id`/`fingerprint`/`createdAt`
 * at run time.
 */
export type SignalPayload = CreateSignalInput;

// ============================================================================
// AUTHOR-FACING CONFIG
// ============================================================================

/** Author-facing configuration for a fix-evaluation scenario. */
export interface FixEvaluationScenarioConfig {
  // Identification
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly tags: readonly string[];

  // Coverage-matrix annotations (per AUTHORING-SPEC §1)
  readonly category:
    | 'error'
    | 'warning'
    | 'performance'
    | 'security'
    | 'architecture'
    | 'quality';
  readonly score: 0 | 1 | 2 | 3 | 4 | 5;
  readonly criteriaMet: readonly string[];
  readonly source:
    | 'fitness'
    | 'simulation'
    | 'assess'
    | 'continuous-review'
    | 'import'
    | 'sarif'
    | 'otlp';
  readonly severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  readonly expectedDifficulty: 'trivial' | 'medium' | 'hard';
  readonly signalIntent: 'actionable' | 'advisory';
  readonly judgmentMode: 'predicate-match' | 'pipeline-judged' | 'human-review';
  readonly provenance: 'real-world-inspired' | 'manual-matrix' | 'llm-authored';
  readonly expectedOutcome: 'success' | 'failure' | 'escalation';

  // Signal payload + predicate composition
  readonly signal: SignalPayload;
  readonly predicate?: PredicateComposition;

  // Optional list of files the scenario targets (used by no-files-outside-target)
  readonly targets?: readonly string[];
}
