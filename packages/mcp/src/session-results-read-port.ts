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
import { BaselineRepo } from '@opensip-cli/datastore';
import {
  bundledReplayResolver,
  listSessionSummaries,
  resolveAndReplaySession,
  type SessionReplayFn,
} from '@opensip-cli/session-store';

import { compareSignalsToBaseline } from './baseline-comparison.js';
import { readError } from './mcp-error.js';
import { buildPersistedReviewBrief, type PersistedReviewStep } from './persisted-review-brief.js';
import { toMcpFinding } from './signal-projection.js';

import type { McpReadError } from './mcp-error.js';
import type {
  CompareToBaselineOptions,
  LatestFindingsOptions,
  McpBaselineComparisonData,
  McpFinding,
  McpReviewChangeData,
  McpResultReplay,
  ReviewChangeOptions,
  RunSummary,
  ShowRunData,
} from './result-dto.js';
import type { ListRunsOptions, ResultsReadPort, ShowRunOptions } from './results-read-port.js';
import type {
  AgentCatalog,
  HistorySuiteGroup,
  HistorySession,
  SignalEnvelope,
  StoredSession,
} from '@opensip-cli/contracts';
import type { Result, ToolRegistry, ToolShortId } from '@opensip-cli/core';
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

  async reviewChange(
    opts: ReviewChangeOptions,
  ): Promise<Result<McpResultReplay<McpReviewChangeData>, McpReadError>> {
    const history = listSessionSummaries(this.store, { summaryOnly: false });
    const group = selectSuiteGroup(history.suiteGroups ?? [], opts);
    if (group === undefined) {
      const detail = missingSuiteGroupMessage(opts);
      return err(readError('not-found', detail));
    }

    const replayStep = async (session: HistorySession): Promise<PersistedReviewStep> => {
      const replayFn = this.replayFor(session.tool);
      if (replayFn === undefined) {
        return {
          session,
          error: `session replay is not available for ${session.tool}`,
          errorCode: 'replay-unavailable',
        };
      }
      try {
        const replay = await replayFn(session);
        return { session, replay };
      } catch (error) {
        return {
          session,
          error: error instanceof Error ? error.message : String(error),
          errorCode: 'decode-error',
        };
      }
    };

    const steps = await Promise.all(group.sessions.map((session) => replayStep(session)));
    const brief = buildPersistedReviewBrief({
      suiteRunId: group.suiteRunId,
      ...(group.suiteName === undefined ? {} : { suiteName: group.suiteName }),
      steps,
      ...(opts.files === undefined ? {} : { files: opts.files }),
      ...(opts.limit === undefined ? {} : { limit: opts.limit }),
    });
    const latestCompletedAt = latestCompleted(group.sessions);
    return ok({
      data: {
        reviewBrief: brief.reviewBrief,
        source: {
          suiteRunId: group.suiteRunId,
          ...(group.suiteName === undefined ? {} : { suiteName: group.suiteName }),
          sessionIds: group.sessions.map((session) => session.id),
          ...(latestCompletedAt === undefined ? {} : { latestCompletedAt }),
        },
        freshness: {
          ...(opts.graphFreshness === undefined ? {} : { graph: opts.graphFreshness }),
          sessions: {
            replayedAt: new Date().toISOString(),
            replayedSessions: steps.filter((step) => step.replay !== undefined).length,
            degradedSteps: brief.degradedSteps,
          },
        },
        ...(brief.degraded === undefined ? {} : { degraded: brief.degraded }),
      },
      recommendedNext: reviewRecommendedNext(group.sessions, opts.graphFreshness?.fresh === false),
    });
  }

  async compareToBaseline(
    opts: CompareToBaselineOptions,
  ): Promise<Result<McpResultReplay<McpBaselineComparisonData>, McpReadError>> {
    const outcome = await resolveAndReplaySession(this.store, {
      ref: opts.ref ?? 'latest',
      tool: opts.tool,
      replayFor: this.replayFor,
    });
    if (!outcome.ok) return err(readError(outcome.reason, outcome.detail));
    const { session, replay } = outcome;

    let repo: BaselineRepo;
    try {
      repo = new BaselineRepo(this.store);
      if (!repo.exists(opts.tool)) {
        return ok({
          data: {
            tool: opts.tool,
            baseline: { available: false },
            delta: {
              added: 0,
              resolved: 0,
              unchanged: 0,
              missingFingerprint: replay.envelope.signals.filter((signal) => !signal.fingerprint)
                .length,
            },
            addedFindings: [],
            degraded: [
              {
                code: 'missing-baseline',
                message:
                  `No stored baseline exists for ${opts.tool}. Run opensip ${opts.tool} ` +
                  '--gate-save to capture one.',
              },
            ],
          },
          session: runSummaryFromReplay(session, replay.envelope),
          recommendedNext: {
            ...recommendedNext(session),
            saveBaselineCommand: `opensip ${opts.tool} --gate-save`,
          },
        });
      }
    } catch (error) {
      return err(
        readError('baseline-error', error instanceof Error ? error.message : String(error)),
      );
    }

    try {
      const rows = repo.load(opts.tool);
      const capturedAt = repo.capturedAt(opts.tool);
      const identity = repo.loadMeta(opts.tool);
      const projection = compareSignalsToBaseline({
        current: replay.envelope.signals,
        baselineRows: rows,
        ...(opts.limit === undefined ? {} : { limit: opts.limit }),
        ...(opts.includeResolved === undefined ? {} : { includeResolved: opts.includeResolved }),
      });
      return ok({
        data: {
          tool: opts.tool,
          baseline: {
            available: true,
            rowCount: rows.length,
            ...(capturedAt === undefined ? {} : { capturedAt: new Date(capturedAt).toISOString() }),
            ...(identity === undefined ? {} : { identity }),
          },
          delta: projection.delta,
          addedFindings: projection.addedFindings,
          ...(projection.resolvedFindings === undefined
            ? {}
            : { resolvedFindings: projection.resolvedFindings }),
          ...(projection.degraded === undefined ? {} : { degraded: projection.degraded }),
        },
        session: runSummaryFromReplay(session, replay.envelope),
        recommendedNext: recommendedNext(session),
      });
    } catch (error) {
      return err(
        readError('baseline-error', error instanceof Error ? error.message : String(error)),
      );
    }
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

function selectSuiteGroup(
  groups: readonly HistorySuiteGroup[],
  opts: ReviewChangeOptions,
): HistorySuiteGroup | undefined {
  if (opts.suiteRunId !== undefined) {
    return groups.find((group) => group.suiteRunId === opts.suiteRunId);
  }
  const candidates =
    opts.suite === undefined ? groups : groups.filter((group) => group.suiteName === opts.suite);
  return candidates[0];
}

function missingSuiteGroupMessage(opts: ReviewChangeOptions): string {
  if (opts.suiteRunId !== undefined) {
    return `suite run ${opts.suiteRunId} was not found`;
  }
  if (opts.suite === undefined) {
    return 'no stored suite run found';
  }
  return `no stored suite run found for suite ${opts.suite}`;
}

function latestCompleted(sessions: readonly HistorySession[]): string | undefined {
  return sessions.map((session) => session.completedAt).sort(compareCodePointDescending)[0];
}

function reviewRecommendedNext(
  sessions: readonly HistorySession[],
  graphStale: boolean,
): Record<string, string> {
  const commands: Record<string, string> = {};
  const first = sessions[0];
  if (first !== undefined) {
    commands.showSourceSessionCommand = `opensip sessions show ${first.id} --json`;
  }
  if (sessions.length > 1) {
    commands.listSuiteSessionsCommand = 'opensip sessions list --json --summary-only';
  }
  if (graphStale) {
    commands.refreshGraphCommand = 'opensip graph --json';
  }
  return commands;
}

function compareCodePointDescending(left: string, right: string): number {
  if (left < right) return 1;
  if (left > right) return -1;
  return 0;
}
