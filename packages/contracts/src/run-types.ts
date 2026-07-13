import type { ReviewBrief } from './review-brief.js';
import type { SuiteRunScope } from './run-context.js';
import type { RunOutcome } from './run-outcome.js';
import type { TaskContextManifest } from './task-context.js';

export type { RunStepReference } from './run-context.js';

export type StoredRunSource =
  | 'implicit-tool'
  | 'configured-suite'
  | 'built-in-suite'
  | 'reconstructed'
  | 'scheduled'
  | 'cloud-triggered'
  | 'mcp-triggered';

export interface StoredRunAggregate {
  readonly steps: number;
  readonly passed: number;
  readonly failed: number;
  readonly faulted: number;
  readonly errors: number;
  readonly warnings: number;
}

export interface StoredRun {
  readonly id: string;
  readonly name: string;
  readonly source: StoredRunSource;
  readonly correlationRunId?: string;
  readonly cwd: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly durationMs: number;
  readonly exitCode: number;
  readonly aggregate: StoredRunAggregate;
  readonly scope?: SuiteRunScope;
  readonly reviewBrief?: ReviewBrief;
  readonly contextManifest?: TaskContextManifest;
  readonly legacySuiteRunId?: string;
  readonly cliVersion?: string;
  readonly engineVersions?: Readonly<Record<string, string>>;
}

export interface StoredRunVerdictSummary {
  readonly passed: boolean;
  readonly errors: number;
  readonly warnings: number;
  readonly findings: number;
}

export interface StoredRunStep {
  readonly id: string;
  readonly runId: string;
  readonly logicalStepKey: string;
  readonly ordinal: number;
  readonly attempt: number;
  readonly tool: string;
  readonly command: string;
  readonly stableId: string;
  readonly effectiveArgs?: Readonly<Record<string, unknown>>;
  readonly exitCode: number;
  readonly outcome: RunOutcome;
  readonly durationMs: number;
  readonly verdictSummary?: StoredRunVerdictSummary;
  readonly sessionId?: string;
  readonly evidence?: unknown;
  readonly parentStepId?: string;
  readonly dependency?: unknown;
}
