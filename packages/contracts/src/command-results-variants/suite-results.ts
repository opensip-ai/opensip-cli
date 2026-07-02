import type { ReviewBrief } from '../review-brief.js';

export interface SuiteStepSummary {
  readonly tool: string;
  readonly stableId: string;
  readonly command: string;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly error?: string;
  /** Present iff the step emitted a SignalEnvelope; absent means no envelope output. */
  readonly verdict?: {
    readonly passed: boolean;
    readonly errors: number;
    readonly warnings: number;
    readonly findings: number;
  };
}

export interface SuiteRunResult {
  type: 'suite-run';
  readonly suite: string;
  readonly suiteRunId: string;
  readonly exitCode: number;
  readonly durationMs: number;
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
