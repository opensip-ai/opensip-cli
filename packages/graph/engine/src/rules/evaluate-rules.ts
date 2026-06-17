/**
 * Shared rule-evaluation loop + per-rule observability.
 *
 * Both build engines (the single-program `runGraph` and the sharded
 * `runShardedGraph`) evaluate the rule set over the unified catalog. They
 * historically carried two byte-identical inline loops — a divergence trap:
 * instrumentation or a fix applied to one silently missed the other (and the
 * sharded loop is the one large monorepos actually take). This module is the
 * single evaluation seam both engines call.
 *
 * **Observability (the regression class this closes).** A single O(N²) rule
 * once dominated the entire "rules" stage while the only signal was the
 * aggregate stage duration — the pathological rule was invisible. This loop
 * times every rule and emits a structured `graph.rule.evaluated` event per
 * rule, plus a louder `graph.rule.slow` WARN when one rule both takes real
 * wall-time AND owns the overwhelming majority of the stage. A future
 * algorithmic regression in any rule surfaces immediately instead of hiding
 * inside the stage total.
 *
 * **Order-preserving.** Rules run sequentially in registration order and
 * signals are appended in that order — byte-for-byte identical to the prior
 * inline loops. Signal array order is observable downstream (fingerprint
 * de-dup, SARIF ordering), so this loop must stay sequential and in-order;
 * it is NOT a parallelism seam.
 */

import { logger, type Signal } from '@opensip-cli/core';

import type { Catalog, FeatureTable, GraphConfig, Indexes, Rule, RuleHints } from '../types.js';

const MODULE_GRAPH_RULES = 'graph:rules';

/**
 * A single rule must exceed BOTH gates to earn a WARN: a wall-time floor (so
 * we never cry wolf on a sub-second stage) AND a share of the stage total (a
 * rule that owns most of the stage is the regression shape we want surfaced).
 */
const SLOW_RULE_MS_FLOOR = 750;
const SLOW_RULE_STAGE_SHARE = 0.5;

/** The frozen pipeline data a rule's `evaluate` consumes. */
export interface RuleEvaluationInput {
  readonly catalog: Catalog;
  readonly indexes: Indexes;
  readonly config: GraphConfig;
  readonly hints?: RuleHints;
  readonly features?: FeatureTable;
}

/**
 * Evaluate `ruleSet` over the unified catalog, accumulating signals in
 * registration order. Emits per-rule timing telemetry; returns the collected
 * signals. The sole rule-evaluation path for both build engines.
 */
export function evaluateRules(ruleSet: readonly Rule[], data: RuleEvaluationInput): Signal[] {
  const { catalog, indexes, config, hints, features } = data;
  const signals: Signal[] = [];
  const durations: { readonly rule: string; readonly durationMs: number }[] = [];
  let stageMs = 0;

  for (const rule of ruleSet) {
    const startedAt = performance.now();
    const ruleSignals = rule.evaluate(catalog, indexes, config, hints, features);
    // Indexed append rather than spread-in-loop — avoids re-allocating the
    // accumulator on every rule (O(n²)) over a potentially large rule set.
    for (const signal of ruleSignals) signals.push(signal);
    const durationMs = performance.now() - startedAt;
    stageMs += durationMs;
    durations.push({ rule: rule.slug, durationMs });
    logger.debug({
      evt: 'graph.rule.evaluated',
      module: MODULE_GRAPH_RULES,
      rule: rule.slug,
      durationMs: round1(durationMs),
      signalCount: ruleSignals.length,
    });
  }

  // Automatic regression alarm: a single rule that takes real time AND owns
  // most of the stage is exactly the shape an algorithmic blowup takes.
  for (const { rule, durationMs } of durations) {
    if (durationMs >= SLOW_RULE_MS_FLOOR && durationMs >= SLOW_RULE_STAGE_SHARE * stageMs) {
      logger.warn({
        evt: 'graph.rule.slow',
        module: MODULE_GRAPH_RULES,
        rule,
        durationMs: round1(durationMs),
        stageMs: round1(stageMs),
        sharePct: Math.round((durationMs / stageMs) * 100),
      });
    }
  }

  return signals;
}

/** Round to one decimal — enough to spot a pathological rule, not noise. */
function round1(ms: number): number {
  return Math.round(ms * 10) / 10;
}
