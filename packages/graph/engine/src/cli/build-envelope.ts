/**
 * @fileoverview Graph's signal-envelope assembly (ADR-0011, Phase 5).
 *
 * Collapses a graph run's flat `Signal[]` into the one tool-run
 * {@link SignalEnvelope}: the shared output currency the composition root
 * renders (table), emits (`--json`), and delivers (cloud + `--report-to`).
 *
 * SARIF ruleId decision — Option A (ADR-0011, Phase 5): at envelope assembly
 * each signal's engine slug (`graph:<rule>`) is mapped to its OpenSIP-
 * convention rule ID (`graph.<family>.<rule>`) via
 * {@link mapEngineSlugToOpenSipRuleId}, set on BOTH `ruleId` AND `source`. One
 * canonical id then flows to `--json`, the terminal table (grouped by
 * `signal.source`), and SARIF (`signal.ruleId`). `mapEngineSlugToOpenSipRuleId`
 * stays graph-owned (tool vocabulary does not belong in the tool-agnostic
 * output layer).
 *
 * Fingerprints (ADR-0036): this builder passes `graphFingerprintStrategy`
 * (`ruleId|filePath|line|col`, `baseline-strategy.ts`) to
 * {@link buildSignalEnvelope}, which stamps every signal at construction — so
 * each built envelope (gate, `--json`, cloud, SARIF) is gate-ready, not just
 * the gate path. The strategy is applied AFTER the Option-A `ruleId` remap
 * below, so fingerprints are computed over the canonical (OpenSIP-convention)
 * rule IDs — byte-identical to the prior post-hoc gate-path stamping. The
 * dashboard session payload (`persistence/session-payload.ts`) keeps
 * the engine slug (its metric-column keys are engine slugs).
 *
 * Pure: no IO, no clock, no id generation — `runId`/`createdAt` arrive on the
 * input (formatter-purity contract).
 */

import { buildSignalEnvelope } from '@opensip-cli/contracts';
import { isErrorSignal, resolveFailOnDegraded, resolveVerdictPolicy } from '@opensip-cli/core';

import { graphFingerprintStrategy } from '../baseline-strategy.js';
import { GRAPH_PARTIAL_COVERAGE_SLUG, graphDegradationMessage } from '../degradation.js';
import { mapEngineSlugToOpenSipRuleId } from '../render/rule-id-mapping.js';

import type { GraphRunDegradation } from '../degradation.js';
import type { SignalEnvelope, UnitResult } from '@opensip-cli/contracts';
import type { Signal, VerdictPolicy } from '@opensip-cli/core';

/** Inputs to {@link buildGraphEnvelope}. */
export interface BuildGraphEnvelopeInput {
  readonly signals: readonly Signal[];
  readonly recipe?: string;
  readonly runId: string;
  readonly createdAt: string;
  /** Whole-run wall-clock; attributed to each unit row when known (else 0). */
  readonly durationMs?: number;
  readonly resolutionMode?: 'exact' | 'fast';
  /** Structured, non-fault coverage loss governed by `failOnDegraded`. */
  readonly degradations?: readonly GraphRunDegradation[];
  /** A genuine pre-unit runtime fault; independent of coverage degradation. */
  readonly runFaulted?: boolean;
}

function degradationSignal(
  value: GraphRunDegradation,
  input: Pick<BuildGraphEnvelopeInput, 'createdAt' | 'runId'>,
): Signal {
  return {
    id: `${input.runId || 'graph'}:${GRAPH_PARTIAL_COVERAGE_SLUG}:${value.condition}`,
    source: GRAPH_PARTIAL_COVERAGE_SLUG,
    provider: 'opensip-cli',
    severity: 'medium',
    category: 'resilience',
    ruleId: GRAPH_PARTIAL_COVERAGE_SLUG,
    message: graphDegradationMessage(value),
    filePath: '.',
    metadata: {
      degradation: true,
      errorCode: value.errorCode,
      condition: value.condition,
      count: value.count,
    },
    createdAt: input.createdAt,
  };
}

/**
 * Keep the warning rung and the independent degradation switch orthogonal.
 * The marker itself must not consume a configured warning allowance when
 * `failOnDegraded:false`; real warning findings retain their original threshold.
 */
function policyForDegradations(policy: VerdictPolicy, degradationCount: number): VerdictPolicy {
  if (degradationCount === 0) return policy;
  if (resolveFailOnDegraded('graph')) return { ...policy, failOnWarnings: 1 };
  if (policy.failOnWarnings === 0) return policy;
  return {
    ...policy,
    failOnWarnings: policy.failOnWarnings + degradationCount,
  };
}

/**
 * Assemble the graph run's {@link SignalEnvelope}.
 *
 * Each signal is remapped to its OpenSIP rule ID (Option A) on both `ruleId`
 * and `source`; signals are then grouped by that mapped source into one
 * {@link UnitResult} per rule that fired (`passed` ⇔ no `critical`/`high` in
 * that group). A rule that emitted no signals produces no unit row — graph's
 * `RunGraphResult` does not carry the full ran-rule set, matching the prior
 * `buildCliOutput` behaviour (one `CheckOutput` per rule that fired).
 */
export function buildGraphEnvelope(input: BuildGraphEnvelopeInput): SignalEnvelope {
  const degradationSignals = (input.degradations ?? []).map((value) =>
    degradationSignal(value, input),
  );
  const mapped: Signal[] = [...input.signals, ...degradationSignals].map((signal) => {
    const ruleId = mapEngineSlugToOpenSipRuleId(signal.ruleId);
    return { ...signal, ruleId, source: ruleId };
  });

  const bySource = new Map<string, Signal[]>();
  for (const signal of mapped) {
    const bucket = bySource.get(signal.source);
    if (bucket) bucket.push(signal);
    else bySource.set(signal.source, [signal]);
  }

  const units: UnitResult[] = [];
  for (const [slug, group] of bySource) {
    const hasError = group.some(isErrorSignal);
    units.push({
      slug,
      passed: !hasError,
      violationCount: group.length,
      durationMs: input.durationMs ?? 0,
    });
  }

  return buildSignalEnvelope({
    tool: 'graph',
    recipe: input.recipe,
    runId: input.runId,
    createdAt: input.createdAt,
    units,
    signals: mapped,
    // D7: partial coverage is a warning-class marker governed independently by
    // failOnDegraded. It never sets the runtime-fault bit.
    policy: policyForDegradations(resolveVerdictPolicy('graph'), degradationSignals.length),
    runFaulted: input.runFaulted ?? false,
    // ADR-0036: graph's byte-preserved identity, stamped at construction (over
    // the remapped canonical ruleIds — see the header note).
    fingerprintStrategy: graphFingerprintStrategy,
    // Honest-approximation marker: surfaced ONLY when the run was fast, so
    // machine consumers see that edges are syntactic/approximate. An exact
    // (or absent) tier carries no marker — parity with the prior CliOutput.
    ...(input.resolutionMode === 'fast' ? { resolutionMode: 'fast' as const } : {}),
  });
}
