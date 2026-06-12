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
 * The gate path stamps `graphFingerprintStrategy` (`ruleId|filePath|line|col`,
 * `baseline-strategy.ts`) onto the built envelope's signals before handing it to
 * the host baseline seams (ADR-0036). The fingerprint excludes `source`, so the
 * remap this builder applies does not churn baselines. The
 * dashboard session payload (`persistence/session-payload.ts`) likewise keeps
 * the engine slug (its metric-column keys are engine slugs).
 *
 * Pure: no IO, no clock, no id generation — `runId`/`createdAt` arrive on the
 * input (formatter-purity contract).
 */

import { buildSignalEnvelope } from '@opensip-tools/contracts';
import { isErrorSignal, resolveVerdictPolicy } from '@opensip-tools/core';

import { mapEngineSlugToOpenSipRuleId } from '../render/rule-id-mapping.js';

import type { SignalEnvelope, UnitResult } from '@opensip-tools/contracts';
import type { Signal } from '@opensip-tools/core';

/** Inputs to {@link buildGraphEnvelope}. */
export interface BuildGraphEnvelopeInput {
  readonly signals: readonly Signal[];
  readonly recipe?: string;
  readonly runId: string;
  readonly createdAt: string;
  /** Whole-run wall-clock; attributed to each unit row when known (else 0). */
  readonly durationMs?: number;
  readonly resolutionMode?: 'exact' | 'fast';
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
  const mapped: Signal[] = input.signals.map((signal) => {
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
      durationMs: 0,
    });
  }

  return buildSignalEnvelope({
    tool: 'graph',
    recipe: input.recipe,
    runId: input.runId,
    createdAt: input.createdAt,
    units,
    signals: mapped,
    // ADR-0035: graph declares no failOn* keys, so it inherits the host fallback
    // {1,0} — reproducing gate-save's "any error-level finding fails" exactly.
    // Graph has no pre-unit fault concept, so runFaulted stays false.
    policy: resolveVerdictPolicy('graph'),
    runFaulted: false,
    // Honest-approximation marker: surfaced ONLY when the run was fast, so
    // machine consumers see that edges are syntactic/approximate. An exact
    // (or absent) tier carries no marker — parity with the prior CliOutput.
    ...(input.resolutionMode === 'fast' ? { resolutionMode: 'fast' as const } : {}),
  });
}
