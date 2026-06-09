/**
 * graph-progress — graph's pipeline-stage → universal progress-currency mapping
 * (ADR-0016), extracted to a React-free module so both the live runner
 * (`graph-runner.tsx`) and the off-process worker (`graph-worker.ts`) share one
 * source of stage labels + the event translation.
 */

import type { GraphProgressEvent, GraphStage } from './orchestrate.js';
import type { ProgressEvent } from '@opensip-tools/cli-ui';

/** Human label per graph pipeline stage (the checklist row text). */
export const STAGE_LABELS: Readonly<Record<GraphStage, string>> = {
  discover: 'Discover files',
  parse: 'Parse project',
  walk: 'Walk catalog',
  resolve: 'Resolve call sites',
  index: 'Build indexes',
  features: 'Derive features',
  rules: 'Evaluate rules',
};

/** Map graph's pipeline event onto the universal progress currency. */
export function toProgressEvent(event: GraphProgressEvent): ProgressEvent {
  if (event.type === 'stage-start') {
    return { type: 'stage-start', stage: event.stage, label: STAGE_LABELS[event.stage] };
  }
  if (event.type === 'stage-done') {
    return { type: 'stage-done', stage: event.stage, durationMs: event.durationMs ?? 0, detail: event.detail };
  }
  return { type: 'stage-cached', stage: event.stage };
}
