/**
 * `ResultsReadPort` — the narrow read interface the MCP result/history tool
 * handlers depend on (ADR-0084). Kept separate from `GraphReadPort` because
 * session reads and graph-catalog reads are distinct backends with distinct
 * consumers (SRP) — each has exactly one production impl + one test fake.
 *
 * Result tools **never** re-execute the underlying OpenSIP tool; they read
 * persisted parent execution Runs or replay persisted Tool Sessions (paired
 * with the `mcp-results-no-rerun` check). The impl reads through the
 * `@opensip-cli/session-store` read API — it never names `SessionRepo` and never
 * raw-queries the datastore.
 */

import type { McpReadError } from './mcp-error.js';
import type {
  CompareToBaselineOptions,
  LatestFindingsOptions,
  McpBaselineComparisonData,
  McpExecutionRunDetailData,
  McpExecutionRunHistoryData,
  McpFinding,
  McpReviewChangeData,
  McpResultReplay,
  ReviewChangeOptions,
  RunSummary,
  ShowRunData,
} from './result-dto.js';
import type { AgentCatalog } from '@opensip-cli/contracts';
import type { Result, ToolShortId } from '@opensip-cli/core';

/** Options for {@link ResultsReadPort.listRuns}. */
export interface ListRunsOptions {
  readonly tool?: ToolShortId;
  readonly limit?: number;
  /** Omit heavy stored payloads (agent-friendly; defaults on in the impl). */
  readonly summaryOnly?: boolean;
}

/** Options for {@link ResultsReadPort.showRun}. */
export interface ShowRunOptions {
  /** Session id, or the sentinel `'latest'` (which requires `tool`). */
  readonly ref: string;
  readonly tool?: ToolShortId;
  /** Agent ergonomics filters applied to the replayed envelope (ADR-0085). */
  readonly filters?: readonly string[];
  /** Request the minimal payload (handler presentation hint). */
  readonly raw?: boolean;
}

/** Options for the canonical parent-Run ledger list. */
export interface ListExecutionRunsOptions {
  readonly limit?: number;
}

/** Options for one exact, paged parent Run read. */
export interface ShowExecutionRunOptions {
  readonly runId: string;
  readonly offset?: number;
  readonly limit?: number;
}

export interface ResultsReadPort {
  /** The self-describing agent command catalog. */
  agentCatalog(): Result<AgentCatalog, McpReadError>;
  /** List canonical parent execution Runs — distinct from Tool Sessions. */
  listExecutionRuns(
    opts?: ListExecutionRunsOptions,
  ): Result<McpExecutionRunHistoryData, McpReadError>;
  /** Read one exact parent Run and its bounded ordered RunStep page. */
  showExecutionRun(opts: ShowExecutionRunOptions): Result<McpExecutionRunDetailData, McpReadError>;
  /** List stored runs as lean {@link RunSummary} pointers. */
  listRuns(opts?: ListRunsOptions): Result<readonly RunSummary[], McpReadError>;
  /** Replay one stored run (resolve `ref`, decode, filter) — never re-run. */
  showRun(opts: ShowRunOptions): Promise<Result<McpResultReplay<ShowRunData>, McpReadError>>;
  /** The latest run's findings for `tool`, severity/limit-filtered. */
  latestFindings(
    opts: LatestFindingsOptions,
  ): Promise<Result<McpResultReplay<readonly McpFinding[]>, McpReadError>>;
  /** Rebuild a v1 review brief from persisted suite sessions — never re-run. */
  reviewChange(
    opts: ReviewChangeOptions,
  ): Promise<Result<McpResultReplay<McpReviewChangeData>, McpReadError>>;
  /** Compare a replayed stored run to the stored baseline rows — never re-run. */
  compareToBaseline(
    opts: CompareToBaselineOptions,
  ): Promise<Result<McpResultReplay<McpBaselineComparisonData>, McpReadError>>;
}
