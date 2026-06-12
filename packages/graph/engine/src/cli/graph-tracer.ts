/**
 * Shared graph tracing constants and the span-emitting {@link RunStage} used by
 * the sharded build's worker processes.
 *
 * The sequential orchestrator ({@link file://./orchestrate.ts}) defines its own
 * `runStage` that also drives the live-view progress callback + pressure
 * monitor; it reuses {@link GRAPH_TRACER} from here so both paths emit spans
 * under the same instrumentation scope and `opensip_cli.graph.*` span names.
 *
 * Shard workers have no live view (they run headless in a subprocess), so they
 * use {@link spanRunStage} — span emission without the progress/monitor plumbing.
 * Before this existed the workers used a pass-through that silently dropped span
 * coverage, so multi-package (sharded) builds emitted no per-stage spans at all.
 */

import { withSpanAsync, type Attributes } from '@opensip-cli/core';

import type { RunStage } from './orchestrate/catalog-builder.js';

/** Instrumentation scope for every graph stage span (sequential and sharded). */
export const GRAPH_TRACER = 'opensip-cli-graph';

/**
 * A {@link RunStage} that emits one span per stage (named
 * `opensip_cli.graph.<stage>`) but does no progress/monitor work — for
 * headless contexts like the shard worker. `baseAttrs` are merged onto every
 * stage span (e.g. the shard id) so spans from parallel workers are
 * distinguishable when they nest under the parent build trace.
 */
export function spanRunStage(baseAttrs: Attributes = {}): RunStage {
  return ({ stage, fn, attrsFn }) =>
    withSpanAsync(
      GRAPH_TRACER,
      `opensip_cli.graph.${stage}`,
      async (span) => {
        const out = await fn();
        if (attrsFn) span.setAttributes(attrsFn(out));
        return out;
      },
      { 'opensip_cli.graph.stage': stage, ...baseAttrs },
    );
}
