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
import { err, logger, ok } from '@opensip-cli/core';
import { BaselineRepo } from '@opensip-cli/datastore';
import {
  bundledReplayResolver,
  isSessionCwdWithin,
  listSessionSummaries,
  resolveSession,
  resolveAndReplaySession,
  type SessionReplayFn,
} from '@opensip-cli/session-store';

import { readError } from './mcp-error.js';
import { buildPersistedReviewBrief, type PersistedReviewStep } from './persisted-review-brief.js';
import {
  baselineComparisonReplay,
  missingBaselineReplay,
  recommendedNext,
  runSummaryFromReplay,
} from './session-reply-builders.js';
import {
  latestCompleted,
  missingSuiteGroupMessage,
  reviewRecommendedNext,
  selectSuiteGroup,
} from './session-review-helpers.js';
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
import type { AgentCatalog, HistorySession, StoredSession } from '@opensip-cli/contracts';
import type { Result, ToolRegistry, ToolShortId } from '@opensip-cli/core';
import type { DataStore } from '@opensip-cli/datastore';

/** The no-op replay resolver used when no tool registry was supplied. */
const noReplay = (): undefined => undefined;

/** Construction deps — all captured once (no ambient scope reads). */
export interface SessionResultsReadPortDeps {
  /** The datastore handle the long-lived server captured at construction. */
  readonly store: DataStore;
  /** Project root that scopes session result reads. Omitted keeps reads unscoped. */
  readonly projectRoot?: string;
  /** Live tool registry — for the agent catalog + the bundled replay resolver. */
  readonly tools?: ToolRegistry;
  /** Override the per-tool replay resolver (defaults to the bundled in-host one). */
  readonly replayFor?: (tool: ToolShortId) => SessionReplayFn | undefined;
  /** Tier-3 internal command names excluded from the agent catalog. */
  readonly internalCommands?: ReadonlySet<string>;
}

export class SessionResultsReadPort implements ResultsReadPort {
  private readonly store: DataStore;
  private readonly projectRoot?: string;
  private readonly tools?: ToolRegistry;
  private readonly replayFor: (tool: ToolShortId) => SessionReplayFn | undefined;
  private readonly internalCommands?: ReadonlySet<string>;

  constructor(deps: SessionResultsReadPortDeps) {
    this.store = deps.store;
    this.projectRoot = deps.projectRoot;
    this.tools = deps.tools;
    this.replayFor = deps.replayFor ?? (deps.tools ? bundledReplayResolver(deps.tools) : noReplay);
    this.internalCommands = deps.internalCommands;
  }

  agentCatalog(): Result<AgentCatalog, McpReadError> {
    return ok(
      buildAgentCatalog({
        ...(this.tools ? { tools: this.tools } : {}),
        ...(this.internalCommands ? { internalCommands: this.internalCommands } : {}),
        validateOverlays: true,
      }),
    );
  }

  listRuns(opts: ListRunsOptions = {}): Result<readonly RunSummary[], McpReadError> {
    const history = listSessionSummaries(this.store, {
      ...(opts.tool ? { tool: opts.tool } : {}),
      ...(opts.limit === undefined ? {} : { limit: opts.limit }),
      ...(this.projectRoot === undefined ? {} : { cwdWithin: this.projectRoot }),
      // Default to the lean projection — agents want pointers, not heavy payloads.
      summaryOnly: opts.summaryOnly ?? true,
      ...(this.tools ? { registry: this.tools } : {}),
    });
    return ok(history.sessions.map(toRunSummary));
  }

  async showRun(opts: ShowRunOptions): Promise<Result<McpResultReplay<ShowRunData>, McpReadError>> {
    const scoped = this.resolveScopedSession(opts.ref, opts.tool);
    if (!scoped.ok) return err(scoped.error);
    const outcome = await resolveAndReplaySession(this.store, {
      ref: opts.ref,
      ...(opts.tool ? { tool: opts.tool } : {}),
      replayFor: this.replayFor,
      ...(opts.filters?.length ? { filters: opts.filters } : {}),
      ...(this.projectRoot === undefined ? {} : { cwdWithin: this.projectRoot }),
    });
    if (!outcome.ok) return err(readError(outcome.reason, outcome.detail));
    const { session, replay, originalSignalCount } = outcome;
    if (!this.isSessionInScope(session)) return this.foreignSessionNotFound(opts.ref, session);
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
    const scoped = this.resolveScopedSession('latest', opts.tool);
    if (!scoped.ok) return err(scoped.error);
    const outcome = await resolveAndReplaySession(this.store, {
      ref: 'latest',
      tool: opts.tool,
      replayFor: this.replayFor,
      ...(filters.length > 0 ? { filters } : {}),
      ...(this.projectRoot === undefined ? {} : { cwdWithin: this.projectRoot }),
    });
    if (!outcome.ok) return err(readError(outcome.reason, outcome.detail));
    const { session, replay, originalSignalCount } = outcome;
    if (!this.isSessionInScope(session)) return this.foreignSessionNotFound('latest', session);
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
    const history = listSessionSummaries(this.store, {
      summaryOnly: false,
      ...(this.projectRoot === undefined ? {} : { cwdWithin: this.projectRoot }),
    });
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
    // Scope the session BEFORE replaying it: a foreign-repo run must be
    // reported as not-found, and must not be compared against this project's
    // baseline (the evidence-corruption class Phase 0 / ADR-0130 closes).
    const scoped = this.resolveScopedSession(opts.ref ?? 'latest', opts.tool);
    if (!scoped.ok) return err(scoped.error);
    const outcome = await resolveAndReplaySession(this.store, {
      ref: opts.ref ?? 'latest',
      tool: opts.tool,
      replayFor: this.replayFor,
      ...(this.projectRoot === undefined ? {} : { cwdWithin: this.projectRoot }),
    });
    if (!outcome.ok) return err(readError(outcome.reason, outcome.detail));
    const { session, replay } = outcome;
    if (!this.isSessionInScope(session))
      return this.foreignSessionNotFound(opts.ref ?? 'latest', session);

    try {
      const repo = new BaselineRepo(this.store);
      return ok(
        repo.exists(opts.tool)
          ? baselineComparisonReplay(repo, opts, session, replay.envelope)
          : missingBaselineReplay(opts.tool, session, replay.envelope),
      );
    } catch (error) {
      return err(
        readError('baseline-error', error instanceof Error ? error.message : String(error)),
      );
    }
  }

  private isSessionInScope(session: StoredSession): boolean {
    return this.projectRoot === undefined || isSessionCwdWithin(session.cwd, this.projectRoot);
  }

  private resolveScopedSession(
    ref: string,
    tool: ToolShortId | undefined,
  ): Result<StoredSession, McpReadError> {
    const resolved = resolveSession(this.store, {
      ref,
      ...(tool === undefined ? {} : { tool }),
      ...(this.projectRoot === undefined ? {} : { cwdWithin: this.projectRoot }),
    });
    if (!resolved.ok) return err(readError(resolved.reason, resolved.detail));
    if (!this.isSessionInScope(resolved.session)) {
      return this.foreignSessionNotFound(ref, resolved.session);
    }
    return ok(resolved.session);
  }

  private foreignSessionNotFound<T>(ref: string, session: StoredSession): Result<T, McpReadError> {
    logger.info({
      evt: 'mcp.results.scope.rejected',
      module: 'mcp:results-read-port',
      ref,
      sessionCwd: session.cwd,
      projectRoot: this.projectRoot,
    });
    return err(readError('not-found', `session ${ref} was not found`));
  }
}

/** Map a `sessions list` row to the lean {@link RunSummary} agent shape. */
function toRunSummary(s: HistorySession): RunSummary {
  return {
    id: s.id,
    tool: s.tool,
    startedAt: s.startedAt,
    completedAt: s.completedAt,
    cwd: s.cwd,
    score: s.score,
    passed: s.passed,
    ...(s.cliVersion === undefined ? {} : { cliVersion: s.cliVersion }),
    ...(s.engineVersion === undefined ? {} : { engineVersion: s.engineVersion }),
    showCommand: s.showCommand,
    ...(s.summary ? { summary: s.summary } : {}),
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
