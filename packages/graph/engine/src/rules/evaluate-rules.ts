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

import {
  createCancelledError,
  createToolError,
  currentScope,
  logger,
  normalizeFailure,
  scrubText,
  toOperatorFailureProjection,
  type Signal,
} from '@opensip-cli/core';

import { graphErrorCatalog } from '../errors/graph-error-catalog.js';

import { createGraphSignal } from './create-graph-signal.js';
import { currentRules } from './registry.js';

import type { Catalog, FeatureTable, GraphConfig, Indexes, Rule, RuleHints } from '../types.js';

const MODULE_GRAPH_RULES = 'graph:rules';

/**
 * A single rule must exceed BOTH gates to earn a WARN: a wall-time floor (so
 * we never cry wolf on a sub-second stage) AND a share of the stage total (a
 * rule that owns most of the stage is the regression shape we want surfaced).
 */
const SLOW_RULE_MS_FLOOR = 750;
const SLOW_RULE_STAGE_SHARE = 0.5;
const RULE_EVALUATION_FAILED = graphErrorCatalog.require('GRAPH.RULE.EVALUATION_FAILED');

/** The frozen pipeline data a rule's `evaluate` consumes. */
export interface RuleEvaluationInput {
  readonly catalog: Catalog;
  readonly indexes: Indexes;
  readonly config: GraphConfig;
  readonly hints?: RuleHints;
  readonly features?: FeatureTable;
}

/** Resolve an explicit rule override or snapshot the current scoped registry. */
export function resolveRuleSet(explicitRules?: readonly Rule[]): readonly Rule[] {
  return explicitRules ?? currentRules();
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
    throwIfRuleEvaluationCancelled();
    const startedAt = performance.now();
    let ruleSignals: readonly Signal[];
    let status: 'passed' | 'failed' = 'passed';
    try {
      ruleSignals = rule.evaluate(catalog, indexes, config, hints, features);
      throwIfRuleEvaluationCancelled();
    } catch (error) {
      ruleSignals = [ruleEvaluationFailureSignal(rule, config, error)];
      status = 'failed';
    }
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
      status,
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

/** Cancellation is control flow, never a rule defect to isolate as a finding. */
function throwIfRuleEvaluationCancelled(): void {
  if (currentScope()?.abortSignal?.aborted === true) {
    throw createCancelledError('Graph rule evaluation cancelled by the host.');
  }
}

/**
 * Convert one rule exception into visible partial evidence without leaking the throwable.
 * Definition-backed causes keep their primary code (D6); unknown causes are normalized at this
 * boundary onto GRAPH.RULE.EVALUATION_FAILED. Both forms carry the boundary code for grouping.
 */
function ruleEvaluationFailureSignal(rule: Rule, config: GraphConfig, error: unknown): Signal {
  const original = normalizeFailure(error);
  if (original.definition.kind === 'cancelled') throw error;

  const safeRule = scrubText(rule.slug, 128);
  const boundaryError = createToolError(
    RULE_EVALUATION_FAILED,
    `Graph rule "${safeRule}" could not be evaluated.`,
    {
      cause: error,
      metadata: {
        condition: 'rule-threw',
        rule: safeRule,
        causeCode: original.code,
      },
    },
  );
  const failure = original.known === 'known' ? original : normalizeFailure(boundaryError);

  logger.error({
    evt: 'graph.rule.evaluation-failed',
    module: MODULE_GRAPH_RULES,
    rule: safeRule,
    boundaryCode: RULE_EVALUATION_FAILED.code,
    failure: toOperatorFailureProjection(failure),
  });

  return createGraphSignal(rule.slug, config, {
    severity: 'high',
    category: 'error',
    message: `Graph rule "${safeRule}" could not be evaluated.`,
    suggestion: RULE_EVALUATION_FAILED.operatorAction,
    metadata: {
      condition: 'rule-threw',
      rule: safeRule,
      errorCode: failure.code,
      boundaryCode: RULE_EVALUATION_FAILED.code,
    },
  });
}

/** Round to one decimal — enough to spot a pathological rule, not noise. */
function round1(ms: number): number {
  return Math.round(ms * 10) / 10;
}
