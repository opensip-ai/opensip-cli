/**
 * Progress currency — the universal live-run event vocabulary consumed by the
 * shared `<LiveProgress>` renderer (ADR-0016). The run-time analogue of
 * `@opensip-tools/contracts`' `SignalEnvelope` *output* currency.
 *
 * Why this lives in cli-ui (not contracts): progress is renderer-bound and
 * ephemeral — it is never persisted or egressed the way a `SignalEnvelope` is.
 * The renderer owns its input vocabulary, and cli-ui depends on ink/react only,
 * so the pure presentational leaf carries no `@opensip-tools/*` dependency.
 *
 * One event union covers both tool shapes:
 *   - `phases` — few, fixed, ordered, named stages (graph's 7-stage pipeline),
 *     rendered as a checklist with one active spinner row.
 *   - `pool`   — many, dynamic, possibly concurrent units (fit's checks, sim's
 *     scenarios), rendered as a single spinner + `completed/total` counter.
 *
 * `stage` is a free-form string id: graph maps its `GraphStage`; pool-shape tools
 * use one synthetic id (`'checks'`, `'scenarios'`).
 */

/** A single live-progress event emitted by a running tool. */
export type ProgressEvent =
  | { readonly type: 'stage-start'; readonly stage: string; readonly label: string }
  | {
      readonly type: 'stage-progress';
      readonly stage: string;
      readonly completed: number;
      readonly total: number;
    }
  | {
      readonly type: 'stage-done';
      readonly stage: string;
      readonly durationMs: number;
      readonly detail?: string;
    }
  /** Phases-mode only: a cache hit satisfied this stage (graph parse/walk/resolve). */
  | { readonly type: 'stage-cached'; readonly stage: string };

/** Listener invoked with each {@link ProgressEvent} as a run progresses. */
export type ProgressCallback = (event: ProgressEvent) => void;

/** Which of the two presentation modes a tool's progress uses. */
export type ProgressShape = 'phases' | 'pool';

/** A fixed pipeline stage declared up front so the checklist can render the
 *  pending (○) row before the stage starts. `id` matches the `stage` field of
 *  this stage's events. `runningDetail` is the dim sub-label shown under the
 *  active spinner row (e.g. "Binding symbols to edges..."). */
export interface ProgressStageDescriptor {
  readonly id: string;
  readonly label: string;
  readonly runningDetail?: string;
}

/**
 * What the renderer needs up front to pick a mode and pre-render rows.
 *   - `phases`: the fixed, ordered stage descriptors.
 *   - `pool`: a label for the single running line (e.g. "Running checks...").
 */
export type ProgressSurface =
  | { readonly shape: 'phases'; readonly stages: readonly ProgressStageDescriptor[] }
  | { readonly shape: 'pool'; readonly label: string };
