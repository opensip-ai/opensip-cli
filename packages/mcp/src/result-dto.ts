/**
 * Result/history DTOs for the MCP {@link ResultsReadPort} (ADR-0084).
 *
 * Every result response carries session provenance + `recommendedNext` commands
 * so an agent can drill in (or re-run) without guessing the CLI grammar. The
 * payloads are the host-owned generic replay projection (the same decoded signal
 * list `sessions show` produces) — never another tool's opaque payload
 * vocabulary (ADR-0042 opacity boundary holds).
 */

import type { SignalEnvelope } from '@opensip-cli/contracts';
import type { SignalSeverity, ToolShortId } from '@opensip-cli/core';

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

/** A compact finding row projected from a replayed envelope signal. */
export interface McpFinding {
  readonly ruleId: string;
  readonly message: string;
  readonly severity: SignalSeverity;
  readonly filePath?: string;
  readonly line?: number;
  readonly column?: number;
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
