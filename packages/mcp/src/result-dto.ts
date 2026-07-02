/**
 * Result/history DTOs for the MCP {@link ResultsReadPort} (ADR-0084).
 *
 * Every result response carries session provenance + `recommendedNext` commands
 * so an agent can drill in (or re-run) without guessing the CLI grammar. The
 * payloads are the host-owned generic replay projection (the same decoded signal
 * list `sessions show` produces) — never another tool's opaque payload
 * vocabulary (ADR-0042 opacity boundary holds).
 */

import type { Freshness } from './symbol-dto.js';
import type { ReviewBrief, SignalEnvelope } from '@opensip-cli/contracts';
import type { BaselineIdentityMetadata, SignalSeverity, ToolShortId } from '@opensip-cli/core';

/** The verdict-count block shared with `SignalEnvelope`. */
export type RunVerdictSummary = SignalEnvelope['verdict']['summary'];

/** A lean stored-run pointer (the `sessions list` row, agent-shaped). */
export interface RunSummary {
  readonly id: string;
  readonly tool: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly score: number;
  readonly passed: boolean;
  /** The `opensip sessions show … --json` command that replays this run. */
  readonly showCommand: string;
  /** Verdict counts when the stored payload carried a summary. */
  readonly summary?: RunVerdictSummary;
}

/** Options for {@link ResultsReadPort.latestFindings}. */
export interface LatestFindingsOptions {
  readonly tool: ToolShortId;
  /** `errors` → errors-only, `warnings` → warnings-only, `all` → no severity filter. */
  readonly severity?: 'errors' | 'warnings' | 'all';
  /** Cap the returned findings (maps to the `top:<n>` filter). */
  readonly limit?: number;
}

/** Options for {@link ResultsReadPort.reviewChange}. */
export interface ReviewChangeOptions {
  /** Exact suite run id. Omitted means latest suite group, optionally by suite name. */
  readonly suiteRunId?: string;
  /** Optional suite-name filter when selecting the latest stored suite group. */
  readonly suite?: string;
  /** Project-relative files used to focus returned risk details. */
  readonly files?: readonly string[];
  /** Cap returned risk details; aggregate counts remain uncapped. */
  readonly limit?: number;
  /** Current graph freshness, supplied by the MCP handler from GraphReadPort. */
  readonly graphFreshness?: Freshness;
}

/** Options for {@link ResultsReadPort.compareToBaseline}. */
export interface CompareToBaselineOptions {
  readonly tool: ToolShortId;
  /** Session id or `latest`; defaults to `latest`. */
  readonly ref?: string;
  /** Cap returned detail rows; aggregate counts remain uncapped. */
  readonly limit?: number;
  /** Include bounded details for resolved baseline rows. */
  readonly includeResolved?: boolean;
}

/** A compact finding row projected from a replayed envelope signal. */
export interface McpFinding {
  readonly ruleId: string;
  readonly message: string;
  readonly severity: SignalSeverity;
  readonly filePath?: string;
  readonly line?: number;
  readonly column?: number;
}

/** Machine-readable degraded evidence note for MCP review/baseline tools. */
export interface McpEvidenceDegradation {
  readonly code:
    | 'missing-baseline'
    | 'missing-fingerprint'
    | 'legacy-baseline-payload'
    | 'replay-unavailable'
    | 'decode-error'
    | 'missing-suite-evidence';
  readonly message: string;
  readonly count?: number;
}

/** Provenance for a review brief reconstructed from stored suite step sessions. */
export interface McpReviewChangeSource {
  readonly suiteRunId: string;
  readonly suiteName?: string;
  readonly sessionIds: readonly string[];
  readonly latestCompletedAt?: string;
}

/** Freshness summary for a persisted review brief response. */
export interface McpReviewChangeFreshness {
  readonly graph?: Freshness;
  readonly sessions: {
    readonly replayedAt: string;
    readonly replayedSessions: number;
    readonly degradedSteps: number;
  };
}

/** The `review_change` payload: v1 ReviewBrief plus persisted evidence context. */
export interface McpReviewChangeData {
  readonly reviewBrief: ReviewBrief;
  readonly source: McpReviewChangeSource;
  readonly freshness: McpReviewChangeFreshness;
  readonly degraded?: readonly McpEvidenceDegradation[];
}

/** Baseline metadata surfaced by `compare_to_baseline`. */
export interface McpBaselineMetadata {
  readonly available: boolean;
  readonly capturedAt?: string;
  readonly rowCount?: number;
  readonly identity?: BaselineIdentityMetadata;
}

/** Fingerprint comparison counts. Detail arrays are separately bounded. */
export interface McpBaselineDelta {
  readonly added: number;
  readonly resolved: number;
  readonly unchanged: number;
  readonly missingFingerprint: number;
}

/** The `compare_to_baseline` payload. */
export interface McpBaselineComparisonData {
  readonly tool: string;
  readonly baseline: McpBaselineMetadata;
  readonly delta: McpBaselineDelta;
  readonly addedFindings: readonly McpFinding[];
  readonly unchangedFindings?: readonly McpFinding[];
  readonly resolvedFindings?: readonly McpFinding[];
  readonly degraded?: readonly McpEvidenceDegradation[];
}

/** The `show_run` payload: the replayed envelope + its fidelity marker. */
export interface ShowRunData {
  /** Always `'projection'` — replays are rebuilt from persisted data. */
  readonly fidelity: 'projection';
  readonly envelope: SignalEnvelope;
}

/**
 * The shared result-replay envelope: `data` + session provenance + (when a
 * filter narrowed the signals) the agent filter metadata + `recommendedNext`
 * follow-up commands.
 */
export interface McpResultReplay<T> {
  readonly data: T;
  readonly session?: RunSummary;
  readonly filtersApplied?: readonly string[];
  readonly originalSignalCount?: number;
  readonly returnedSignalCount?: number;
  readonly recommendedNext?: Record<string, string>;
}
