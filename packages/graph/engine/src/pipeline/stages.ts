/**
 * Shared stage-name vocabulary for the graph pipeline.
 *
 * The orchestrator drives six stages end-to-end (`discover`, `parse`,
 * `walk`, `resolve`, `index`, `rules`). The cache module's
 * incremental rebuild path runs three of those (`parse`, `walk`,
 * `resolve`) and used to declare its own hardcoded subset union —
 * which duplicated the vocabulary and would silently drift if a
 * future stage joined the rebuild path.
 *
 * This module is the single source of truth: `GraphStage` is the
 * canonical pipeline alphabet; `RebuildStage` is the cache module's
 * subset, derived via `Extract<>` so any rename or addition lands
 * in one place. Both `cli/orchestrate.ts` and `cache/incremental.ts`
 * import from here. Audit 2026-05-23 N-3.
 */

/** Pipeline stage identity, in canonical order. */
export type GraphStage =
  | 'discover'
  | 'parse'
  | 'walk'
  | 'resolve'
  | 'index'
  | 'rules';

/** Canonical stage order — consumed by the live view to render the checklist. */
export const GRAPH_STAGES: readonly GraphStage[] = [
  'discover',
  'parse',
  'walk',
  'resolve',
  'index',
  'rules',
];

/**
 * Subset of `GraphStage` exercised by the incremental rebuild path
 * in `cache/incremental.ts`. Derived via `Extract<>` so a rename of
 * any of these literals at the source happens in `GraphStage` and
 * propagates here for free.
 */
export type RebuildStage = Extract<GraphStage, 'parse' | 'walk' | 'resolve'>;
