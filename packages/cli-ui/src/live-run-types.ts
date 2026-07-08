/**
 * Live-run shell prop and state types (shared by live-run + live-run-views).
 */

import type { LiveRunTableRow } from './live-run-table.js';
import type { ProgressCallback, ProgressSurface } from './progress-event.js';
import type { ResultSummaryItem } from './result-summary.js';
import type { RunTimerLike } from './run-timing-provider.js';
import type { FindingGroupView } from './verbose-detail.js';
import type { ViewNode } from './view-model.js';

export interface LiveRunMeta {
  readonly title: string;
  readonly description: string;
}

export interface LiveRunSummaryData {
  readonly passed: boolean;
  /** True when the run faulted (a unit threw) — the headline reads FAULT not FAIL. */
  readonly faulted?: boolean;
  readonly errors: number;
  readonly warnings: number;
  readonly durationMs?: number;
}

/**
 * The attention-only result block for the compact live done-body: 3-way unit
 * counts + one item per unit (failed/faulted highlighted). Structurally the
 * data half of `ResultSummaryProps`; the host derives it from the run envelope
 * (`contracts.envelopeToResultSummary`) so TTY and pipe render the same block.
 */
export interface LiveRunAttention {
  readonly counts: { readonly passed: number; readonly failed: number; readonly faulted: number };
  readonly items: readonly ResultSummaryItem[];
}

export interface LiveRunDoneData {
  readonly summary: LiveRunSummaryData;
  readonly verboseLines?: readonly string[];
  readonly verboseFindings?: readonly FindingGroupView[];
  readonly warnings?: readonly string[];
  readonly banner?: string;
  readonly table?: readonly LiveRunTableRow[];
  /** Attention bullets for the compact (non-verbose) surface; absent for a clean run. */
  readonly attention?: LiveRunAttention;
  /**
   * One ADDITIVE line rendered directly under the run-summary headline, on every
   * surface (not verbose-gated). A tool-specific note that rides WITH the standard
   * §4 summary rather than replacing it — e.g. the suite's one-line review verdict
   * (`Review: PASS · no risks found`). Keep it to a single line; richer detail
   * belongs in {@link verboseExtra}.
   */
  readonly summaryNote?: ViewNode;
  /**
   * Additional VERBOSE-only detail rendered above the summary (only when
   * `--verbose`). Additive — it does not replace any standard section. Used for
   * tool-specific tables the standard slots don't model, e.g. the suite's per-step
   * table + review-risk tables.
   */
  readonly verboseExtra?: ViewNode;
}

export type ProgressSubscribe = (cb: ProgressCallback) => void;

export type LiveRunState =
  | { readonly phase: 'loading' }
  | { readonly phase: 'running'; readonly subscribe: ProgressSubscribe }
  | {
      readonly phase: 'done';
      readonly subscribe?: ProgressSubscribe;
      readonly data: LiveRunDoneData;
    }
  | { readonly phase: 'error'; readonly message: string; readonly suggestion?: string };

/** Structural subset of host presentation settings the chrome reads. */
export interface LiveRunUi {
  readonly bannerSize?: string;
  readonly version?: string;
  readonly update?: string;
}

export interface LiveRunHeaderMeta {
  readonly label: string;
  readonly value: string;
}

export interface LiveRunProps {
  readonly meta: LiveRunMeta;
  readonly surface: ProgressSurface;
  readonly loadingSurface?: ProgressSurface;
  readonly state: LiveRunState;
  readonly verbose: boolean;
  readonly quiet: boolean;
  readonly timer?: RunTimerLike;
  readonly ui?: LiveRunUi;
  readonly projectPath?: string;
  readonly walkedUp?: number;
  readonly headerMetadata?: readonly LiveRunHeaderMeta[];
  readonly showRunHeader?: boolean;
  readonly loadingMessage?: string;
}
