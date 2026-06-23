/**
 * Live-run shell prop and state types (shared by live-run + live-run-views).
 */

import type { LiveRunTableRow } from './live-run-table.js';
import type { ProgressCallback, ProgressSurface } from './progress-event.js';
import type { RunTimerLike } from './run-timing-provider.js';
import type { FindingGroupView } from './verbose-detail.js';

export interface LiveRunMeta {
  readonly title: string;
  readonly description: string;
}

export interface LiveRunSummaryData {
  readonly passed: boolean;
  readonly errors: number;
  readonly warnings: number;
  readonly durationMs?: number;
}

export interface LiveRunDoneData {
  readonly summary: LiveRunSummaryData;
  readonly verboseLines?: readonly string[];
  readonly verboseFindings?: readonly FindingGroupView[];
  readonly warnings?: readonly string[];
  readonly banner?: string;
  readonly table?: readonly LiveRunTableRow[];
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
