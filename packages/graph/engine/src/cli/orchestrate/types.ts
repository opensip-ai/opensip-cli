/**
 * Shared types for the graph orchestration pipeline. Extracted into a
 * leaf module so the orchestrator (`../orchestrate.ts`) and its
 * helpers (`cache-orchestrator.ts`, `catalog-builder.ts`) can all
 * reference the same `GraphStage` / `GraphProgressCallback` shapes
 * without forming a file-level cycle.
 *
 * Previously these lived in `../orchestrate.ts` and the helpers
 * type-imported them back from there — closing a cycle the
 * `circular-import-detection` check flagged. Hosting the types here
 * inverts the dependency: the orchestrator and both helpers now
 * import from this leaf, and nothing in this file imports back.
 */

/** Canonical pipeline stages, in execution order. */
export type GraphStage = 'discover' | 'parse' | 'walk' | 'resolve' | 'index' | 'features' | 'rules';

/** Stage order — consumed by the live view to render the checklist. */
export const GRAPH_STAGES: readonly GraphStage[] = [
  'discover',
  'parse',
  'walk',
  'resolve',
  'index',
  'features',
  'rules',
];

/**
 * Structured progress event. `stage-cached` fires for parse/walk/resolve
 * when the on-disk catalog cache satisfies the run; the view renders
 * those stages as "(cached)" instead of running them.
 */
export interface GraphProgressEvent {
  readonly type: 'stage-start' | 'stage-done' | 'stage-cached';
  readonly stage: GraphStage;
  readonly durationMs?: number;
  readonly detail?: string;
}

/** Callback invoked with each {@link GraphProgressEvent} during graph orchestration. */
export type GraphProgressCallback = (event: GraphProgressEvent) => void;
