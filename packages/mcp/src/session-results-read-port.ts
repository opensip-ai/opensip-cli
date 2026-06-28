/**
 * Session-backed {@link ResultsReadPort} (ADR-0084).
 *
 * Implements the result/history reads over the `@opensip-cli/session-store`
 * read API (`listSessionSummaries` / `resolveAndReplaySession` / the bundled
 * replay resolver) and the `@opensip-cli/contracts` `buildAgentCatalog`. It is
 * constructed from an injected `DataStore` (+ the live `ToolRegistry`) captured
 * once — it NEVER calls `currentScope()` inside a method (the long-lived server
 * captures scope at construction; Phase 3). It NEVER names `SessionRepo`, never
 * raw-queries the datastore, and never re-runs the underlying tool — replay only
 * (the `mcp-results-no-rerun` invariant). Every method returns `Result<T, E>`.
 */

import { buildAgentCatalog } from '@opensip-cli/contracts';
import { err, ok } from '@opensip-cli/core';
import {
  bundledReplayResolver,
  listSessionSummaries,
  resolveAndReplaySession,
  type SessionReplayFn,
} from '@opensip-cli/session-store';

import { readError } from './mcp-error.js';

import type { McpReadError } from './mcp-error.js';
import type {
  LatestFindingsOptions,
  McpFinding,
  McpResultReplay,
  RunSummary,
  ShowRunData,
} from './result-dto.js';
import type { ListRunsOptions, ResultsReadPort, ShowRunOptions } from './results-read-port.js';
import type {
  AgentCatalog,
  HistorySession,
  SignalEnvelope,
  StoredSession,
} from '@opensip-cli/contracts';
import type { Result, Signal, ToolRegistry, ToolShortId } from '@opensip-cli/core';
import type { DataStore } from '@opensip-cli/datastore';

/** The no-op replay resolver used when no tool registry was supplied. */
const noReplay = (): undefined => undefined;

/** Construction deps — all captured once (no ambient scope reads). */
export interface SessionResultsReadPortDeps {
  /** The datastore handle the long-lived server captured at construction. */
  readonly store: DataStore;
  /** Live tool registry — for the agent catalog + the bundled replay resolver. */
  readonly tools?: ToolRegistry;
  /** Override the per-tool replay resolver (defaults to the bundled in-host one). */
  readonly replayFor?: (tool: ToolShortId) => SessionReplayFn | undefined;
  /** Tier-3 internal command names excluded from the agent catalog. */
  readonly internalCommands?: ReadonlySet<string>;
}

export class SessionResultsReadPort implements ResultsReadPort {
  private readonly store: DataStore;
  private readonly tools?: ToolRegistry;
  private readonly replayFor: (tool: ToolShortId) => SessionReplayFn | undefined;
  private readonly internalCommands?: ReadonlySet<string>;

  constructor(deps: SessionResultsReadPortDeps) {
    this.store = deps.store;
    this.tools = deps.tools;
    this.replayFor = deps.replayFor ?? (deps.tools ? bundledReplayResolver(deps.tools) : noReplay);
    this.internalCommands = deps.internalCommands;
  }

  agentCatalog(): Result<AgentCatalog, McpReadError> {
    return ok(
      buildAgentCatalog({
        ...(this.tools ? { tools: this.tools } : {}),
        ...(this.internalCommands ? { internalCommands: this.internalCommands } : {}),
      }),
    );
  }

  listRuns(opts: ListRunsOptions = {}): Result<readonly RunSummary[], McpReadError> {
    const history = listSessionSummaries(this.store, {
      ...(opts.tool ? { tool: opts.tool } : {}),
      ...(opts.limit === undefined ? {} : { limit: opts.limit }),
      // Default to the lean projection — agents want pointers, not heavy payloads.
      summaryOnly: opts.summaryOnly ?? true,
      ...(this.tools ? { registry: this.tools } : {}),
    });
    return ok(history.sessions.map(toRunSummary));
  }

  async showRun(opts: ShowRunOptions): Promise<Result<McpResultReplay<ShowRunData>, McpReadError>> {
    const outcome = await resolveAndReplaySession(this.store, {
      ref: opts.ref,
      ...(opts.tool ? { tool: opts.tool } : {}),
      replayFor: this.replayFor,
      ...(opts.filters?.length ? { filters: opts.filters } : {}),
    });
    if (!outcome.ok) return err(readError(outcome.reason, outcome.detail));
    const { session, replay, originalSignalCount } = outcome;
    return ok({
      data: { fidelity: replay.fidelity, envelope: replay.envelope },
      session: runSummaryFromReplay(session, replay.envelope),
      ...filterMeta(opts.filters, originalSignalCount, replay.envelope.signals.length),
      recommendedNext: recommendedNext(session),
    });
  }

  async latestFindings(
    opts: LatestFindingsOptions,
  ): Promise<Result<McpResultReplay<readonly McpFinding[]>, McpReadError>> {
    const filters = severityFilters(opts);
    const outcome = await resolveAndReplaySession(this.store, {
      ref: 'latest',
      tool: opts.tool,
      replayFor: this.replayFor,
      ...(filters.length > 0 ? { filters } : {}),
    });
    if (!outcome.ok) return err(readError(outcome.reason, outcome.detail));
    const { session, replay, originalSignalCount } = outcome;
    const findings = replay.envelope.signals.map(toMcpFinding);
    return ok({
      data: findings,
      session: runSummaryFromReplay(session, replay.envelope),
      ...filterMeta(filters, originalSignalCount, findings.length),
      recommendedNext: recommendedNext(session),
    });
  }
}

/** Map a `sessions list` row to the lean {@link RunSummary} agent shape. */
function toRunSummary(s: HistorySession): RunSummary {
  return {
    id: s.id,
    tool: s.tool,
    startedAt: s.startedAt,
    completedAt: s.completedAt,
    score: s.score,
    passed: s.passed,
    showCommand: s.showCommand,
    ...(s.summary ? { summary: s.summary } : {}),
  };
}

/** Build a {@link RunSummary} for a replayed run (summary from the envelope verdict). */
function runSummaryFromReplay(session: StoredSession, envelope: SignalEnvelope): RunSummary {
  return {
    id: session.id,
    tool: session.tool,
    startedAt: session.startedAt,
    completedAt: session.completedAt,
    score: session.score,
    passed: session.passed,
    showCommand: `opensip sessions show ${session.id} --json`,
    summary: envelope.verdict.summary,
  };
}

/** Project a replayed envelope signal to a compact {@link McpFinding}. */
function toMcpFinding(signal: Signal): McpFinding {
  return {
    ruleId: signal.ruleId,
    message: signal.message,
    severity: signal.severity,
    ...(signal.filePath ? { filePath: signal.filePath } : {}),
    ...(signal.line === undefined ? {} : { line: signal.line }),
    ...(signal.column === undefined ? {} : { column: signal.column }),
  };
}

/** The `--filter` vocabulary for a {@link LatestFindingsOptions} request. */
function severityFilters(opts: LatestFindingsOptions): string[] {
  const filters: string[] = [];
  if (opts.severity === 'errors') filters.push('errors-only');
  else if (opts.severity === 'warnings') filters.push('warnings-only');
  if (opts.limit !== undefined) filters.push(`top:${String(opts.limit)}`);
  return filters;
}

/** Agent filter metadata, present only when a filter actually narrowed the set. */
function filterMeta(
  filters: readonly string[] | undefined,
  originalSignalCount: number,
  returnedSignalCount: number,
): Pick<
  McpResultReplay<unknown>,
  'filtersApplied' | 'originalSignalCount' | 'returnedSignalCount'
> {
  if (!filters?.length) return {};
  return { filtersApplied: filters, originalSignalCount, returnedSignalCount };
}

/** Follow-up commands an agent should prefer over re-running the tool. */
function recommendedNext(session: StoredSession): Record<string, string> {
  const tool = session.tool;
  return {
    showLatestErrorsCommand: `opensip sessions show latest --tool ${tool} --json --filter errors-only`,
    showLatestWarningsCommand: `opensip sessions show latest --tool ${tool} --json --filter warnings-only`,
    showRawEnvelopeCommand: `opensip sessions show ${session.id} --json --raw`,
    rerunCommand: `opensip ${tool}`,
  };
}
