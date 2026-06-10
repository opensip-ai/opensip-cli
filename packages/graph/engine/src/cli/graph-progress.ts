/**
 * graph-progress — graph's pipeline-stage → universal progress-currency mapping
 * (ADR-0016), extracted to a React-free module so both the live runner
 * (`graph-runner.tsx`) and the off-process worker (`graph-worker.ts`) share one
 * source of stage labels + the event translation.
 */

import type { GraphProgressEvent, GraphStage } from './orchestrate.js';
import type { ProgressEvent } from '@opensip-tools/cli-ui';

/**
 * Human label per graph pipeline stage (the checklist row text) for the
 * single-program (exact) engine.
 */
export const STAGE_LABELS: Readonly<Record<GraphStage, string>> = {
  discover: 'Discover files',
  parse: 'Parse project',
  walk: 'Walk catalog',
  resolve: 'Resolve call sites',
  index: 'Build indexes',
  features: 'Derive features',
  rules: 'Evaluate rules',
};

/**
 * Sharded-engine checklist labels. The sharded pipeline runs per-shard
 * parse/walk/resolve INSIDE parallel subprocesses — that is the `parse` stage
 * (the shard build, where the bulk of resolution happens) — then the main thread
 * merges fragments (`walk`) and links cross-package calls (`resolve`). These
 * labels name what each stage actually does in sharded mode, so the checklist
 * doesn't mislabel the shard build as "Parse project" or show a near-empty
 * "Resolve call sites". discover/index/features/rules are identical to the exact
 * engine (same main-thread work).
 */
export const SHARDED_STAGE_LABELS: Readonly<Record<GraphStage, string>> = {
  ...STAGE_LABELS,
  parse: 'Build shards',
  walk: 'Merge catalog',
  resolve: 'Link cross-package',
};

/**
 * Map graph's pipeline event onto the universal progress currency. `sharded`
 * selects the engine-appropriate checklist labels (the two engines run genuinely
 * different stages; `isTTY`/transport never affects this — only the engine does).
 */
export function toProgressEvent(event: GraphProgressEvent, sharded = false): ProgressEvent {
  const labels = sharded ? SHARDED_STAGE_LABELS : STAGE_LABELS;
  if (event.type === 'stage-start') {
    return { type: 'stage-start', stage: event.stage, label: labels[event.stage] };
  }
  if (event.type === 'stage-done') {
    return { type: 'stage-done', stage: event.stage, durationMs: event.durationMs ?? 0, detail: event.detail };
  }
  return { type: 'stage-cached', stage: event.stage };
}
