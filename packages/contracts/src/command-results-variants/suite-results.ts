import type { ImpactTrust } from '../impact-trust.js';
import type { ReviewBrief } from '../review-brief.js';
import type { RunOutcome } from '../run-outcome.js';

export type SuiteRunScopeMode = 'changed' | 'full';
export type SuiteRunScopeSource = 'default' | 'explicit' | 'fallback';

export interface SuiteRunScope {
  readonly mode: SuiteRunScopeMode;
  /** Why this mode applies: built-in default, user flag, or no-git fallback. */
  readonly source: SuiteRunScopeSource;
  /** Git ref base when running with --since. */
  readonly ref?: string;
  /** Changed-file count from the host-side resolution (display/brief only). */
  readonly changedFiles?: number;
  /** Human-readable notice, e.g. the no-git fallback explanation. */
  readonly notice?: string;
}

export interface SuiteStepSummary {
  readonly tool: string;
  readonly stableId: string;
  readonly command: string;
  readonly exitCode: number;
  readonly durationMs: number;
  /**
   * The step's authoritative 3-way outcome — the single source of truth shared
   * with single-tool runs (via {@link deriveOutcome} over the step's
   * `RunVerdict`). A UNIT-level fault (a check that threw, surfaced as
   * `verdict.faulted` in the emitted envelope) reads `faulted` here even when
   * `error` (a run-LEVEL throw) is absent — the old `error`-only heuristic
   * mislabeled that case `failed`. Prefer this over re-deriving from
   * `exitCode`/`verdict`/`error`.
   */
  readonly outcome: RunOutcome;
  readonly error?: string;
  /** Machine-readable ToolError/reportFailure code when the step failed before a verdict. */
  readonly errorCode?: string;
  /** Present iff the step emitted a SignalEnvelope; absent means no envelope output. */
  readonly verdict?: {
    readonly passed: boolean;
    readonly errors: number;
    readonly warnings: number;
    readonly findings: number;
  };
  readonly verification?: ImpactTrust;
}

export interface SuiteRunResult {
  type: 'suite-run';
  readonly suite: string;
  /** Authoritative persisted parent Run identity; absent when persistence was unavailable. */
  readonly runId?: string;
  /** Legacy suite correlation identity retained for replay and existing joins. */
  readonly suiteRunId: string;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly scope?: SuiteRunScope;
  /**
   * True when the run requested `--verbose`. Display-only: the default surface is
   * the count line + per-step bullets; verbose additionally renders the review
   * risks/correlated/degraded tables and the full per-step table. Optional/
   * forward-compat (absent ⇒ compact).
   */
  readonly verbose?: boolean;
  readonly aggregate?: {
    readonly steps: number;
    /** Steps with a passing emitted verdict and a successful step exit. */
    readonly passed: number;
    /** Non-faulted steps with a failing emitted verdict or non-zero step exit. */
    readonly failed: number;
    /** Steps that threw or faulted before completing normally. */
    readonly faulted: number;
    readonly errors: number;
    readonly warnings: number;
  };
  readonly steps: readonly SuiteStepSummary[];
  readonly reviewBrief?: ReviewBrief;
}

export interface SuiteListStep {
  readonly tool: string;
  readonly stableId: string;
  readonly command: string;
  readonly args: Readonly<Record<string, unknown>>;
}

export interface SuiteListEntry {
  readonly name: string;
  readonly description?: string;
  readonly steps: readonly SuiteListStep[];
}

export interface SuiteListResult {
  type: 'suite-list';
  readonly suites: readonly SuiteListEntry[];
  readonly totalCount: number;
}

export interface SuiteAddResult {
  type: 'suite-add';
  readonly suite: string;
  readonly tool: string;
  readonly stableId: string;
  readonly command: string;
  readonly configPath: string;
  readonly changed: boolean;
}
