/**
 * @fileoverview Graph SARIF adapter — TEMPORARY (removed in Phase 5).
 *
 * The canonical signal → SARIF v2.1.0 emitter was promoted (moved) into
 * `@opensip-tools/output` as `buildOpenSipSarif` / `formatSignalSarif`
 * (ADR-0011, Phase 2 Task 2.4). This file keeps the graph-side
 * `renderSarifOpenSip(signals, context)` signature so existing call sites
 * (`cli/sarif-export.ts`, tests) keep working unchanged; Phase 5 rewires
 * graph to emit the envelope and route through `formatSignalSarif`, after
 * which this adapter (and `render/sarif.ts`) are deleted.
 *
 * Graph-vocabulary stays in graph: this adapter applies the
 * `engine-slug → OpenSIP-rule-ID` mapping (`mapEngineSlugToOpenSipRuleId`)
 * before delegating. The shared output layer is tool-agnostic and emits
 * each signal's `ruleId` verbatim.
 */
import { buildOpenSipSarif } from '@opensip-tools/output';

import { mapEngineSlugToOpenSipRuleId } from './rule-id-mapping.js';

import type { Signal } from '@opensip-tools/core';

/** Required context — caller (`cli/graph.ts`) provides tool identity. */
interface RenderSarifContext {
  /** Tool driver name, e.g. `'opensip-tools-graph'`. */
  readonly tool: string;
  /** Tool driver version — typically the engine package version. */
  readonly toolVersion: string;
}

/**
 * Build a SARIF v2.1.0 log from engine `Signal[]`, applying the OpenSIP
 * rule-ID convention, then delegating to the canonical shared emitter.
 *
 * @throws {ValidationError} when any signal's `ruleId` is not a known engine
 *   slug — propagates from `mapEngineSlugToOpenSipRuleId`.
 */
export function renderSarifOpenSip(
  signals: readonly Signal[],
  context: RenderSarifContext,
): string {
  const mapped = signals.map((signal) => ({
    ...signal,
    ruleId: mapEngineSlugToOpenSipRuleId(signal.ruleId),
  }));

  return buildOpenSipSarif(mapped, {
    name: context.tool,
    version: context.toolVersion,
  });
}
