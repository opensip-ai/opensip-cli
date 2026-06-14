// @fitness-ignore-file architecture-session-timing-not-host-owned -- THIS IS the host run-lifecycle plane (spec §9.2 "Allowed: host run lifecycle plane"). It is the single sanctioned owner of generic StoredSession timing + persistence; the host-side persistMs clock (performance.now) and the SessionRepo write live here by design. Phase 7 replaces this blanket ignore with a path-based allow in the check.
/**
 * run-plane — the host-owned run lifecycle plane (host-owned-run-timing §6, §8).
 *
 * The single place that:
 *  - creates the per-invocation {@link RunLifecycle} (inside the command action,
 *    after `RunScope` entry, before tool work — NOT at context construction);
 *  - turns a tool-returned {@link ToolSessionContribution} into a persisted
 *    generic `StoredSession` row (host stamps `startedAt` / `completedAt` /
 *    `durationMs` from the lifecycle; the tool supplies only verdict/payload);
 *  - records host-side overhead (persistMs now; render/egress/ttyBusy/total in
 *    later phases) in the sibling host-metrics record keyed by session id.
 *
 * `buildToolCliContext` constructs only the FACTORY (stable deps). The command
 * action begins the invocation lifecycle and, after the handler / live renderer
 * returns its completion, asks the plane to complete + persist.
 *
 * Best-effort contract: persistence never throws, never affects the primary
 * result or exit code. When no datastore is in scope (non-project commands,
 * tests) the plane writes nothing and returns `undefined`.
 */

import {
  createRunLifecycle,
  generatePrefixedId,
  logger as defaultLogger,
  type Logger,
  type RecordedToolRunSession,
  type RunLifecycle,
  type RunTimingSnapshot,
  type ToolDashboardContribution,
  type ToolRunCompletion,
  type ToolRunSessionInput,
  type ToolSessionContribution,
  type ToolShortId,
} from '@opensip-cli/core';
import { SessionRepo } from '@opensip-cli/session-store';

import type { StoredSessionHostMetrics } from '@opensip-cli/contracts';
import type { DataStore } from '@opensip-cli/datastore';

const MODULE_TAG = 'cli:run-plane';

/** Stable dependencies the run-plane factory captures (no per-invocation state). */
export interface RunPlaneDeps {
  /** Resolve the project datastore, or undefined when none is in scope. Must not throw. */
  readonly getDatastore: () => DataStore | undefined;
  readonly logger?: Logger;
}

/**
 * The per-invocation run lifecycle handle. Created once per command action by
 * {@link RunPlaneFactory.beginRun} (or lazily by {@link RunPlaneFactory.current}).
 */
export interface RunPlaneInvocation {
  /** The lifecycle for this invocation (display elapsed; host completion source). */
  readonly lifecycle: RunLifecycle;
  /**
   * TRANSITIONAL: persist a contribution using a *live* snapshot (does not
   * freeze the lifecycle). Backs the legacy `runSession.record(...)` seam until
   * tools return contributions (Phase 3). Best-effort.
   */
  record(input: ToolRunSessionInput): RecordedToolRunSession | undefined;
  /**
   * The launch path: freeze the lifecycle (`complete()`) and persist the
   * contribution with the frozen `startedAt` / `completedAt` / `durationMs`.
   * Idempotent on the lifecycle; best-effort on persistence.
   *
   * If the run also produced a {@link ToolDashboardContribution} (Phase 5), it
   * is persisted keyed by the same session id once the row is written — so a
   * later `opensip report` process can hydrate the per-run tab without any
   * in-memory state. Best-effort: a missing/failed dashboard write never throws
   * and never affects the session row.
   */
  completeAndPersist(
    contribution: ToolSessionContribution,
    dashboard?: ToolDashboardContribution,
  ): RecordedToolRunSession | undefined;
  /** Best-effort upsert of host-side overhead metrics for the persisted session. */
  recordHostMetrics(metrics: StoredSessionHostMetrics): void;
  /**
   * Run a live render and own its completion: time the TTY occupancy, then —
   * if the renderer returned a `session` contribution — freeze the lifecycle,
   * persist it, and record `ttyBusyMs`. Returns the renderer's completion
   * unchanged so the caller can still read `.envelope` for egress.
   *
   * This is the live-path analogue of `completeAndPersist`: the renderer no
   * longer calls a session writer inside the Ink tree; the host persists here
   * after `await render()`.
   */
  completeLiveRender(
    render: () => Promise<ToolRunCompletion | void>,
  ): Promise<ToolRunCompletion | void>;
  /** The persisted session id, once a row has been written (else undefined). */
  sessionId(): string | undefined;
}

/**
 * Internal run-lifecycle hooks the host attaches to the command context so the
 * mount dispatch can mark the lifecycle boundaries. NOT part of the public
 * `ToolCliContext` — read via cast at the dispatch site (like `runSession`).
 */
export interface RunActionHooks {
  /** Begin the invocation lifecycle — called by the command action before the handler runs. */
  readonly beginRun?: () => void;
  /**
   * Called after the handler returns. If the result carries a
   * {@link ToolSessionContribution} (a `ToolRunCompletion`), the host freezes
   * the lifecycle and persists it. A plain `CommandResult` (no `session`) is a
   * no-op — the transitional `record(...)` path still owns persistence until
   * tools return contributions (Phase 3).
   */
  readonly completeRun?: (result: unknown) => void;
}

/**
 * The factory `buildToolCliContext` creates. Holds only stable deps; the
 * lifecycle is created per command action.
 */
export interface RunPlaneFactory {
  /** Begin (or return the already-begun) invocation lifecycle for this command action. */
  beginRun(): RunPlaneInvocation;
  /** The current invocation — lazily begun if the command action has not yet called beginRun. */
  current(): RunPlaneInvocation;
}

export function createRunPlaneFactory(deps: RunPlaneDeps): RunPlaneFactory {
  const log = deps.logger ?? defaultLogger;
  // One command per CLI invocation: a single mutable invocation slot is correct.
  let invocation: RunPlaneInvocation | undefined;

  function safeDatastore(): DataStore | undefined {
    try {
      return deps.getDatastore();
    } catch {
      return;
    }
  }

  function makeInvocation(): RunPlaneInvocation {
    const lifecycle = createRunLifecycle();
    let sessionId: string | undefined;

    function persist(
      contribution: ToolSessionContribution,
      snapshot: RunTimingSnapshot,
    ): RecordedToolRunSession | undefined {
      const datastore = safeDatastore();
      if (!datastore) return;
      const id = generatePrefixedId(contribution.tool);
      const persistStart = performance.now();
      try {
        const repo = new SessionRepo(datastore);
        repo.save({
          id,
          tool: contribution.tool,
          startedAt: snapshot.startedAt,
          completedAt: snapshot.completedAt,
          cwd: contribution.cwd,
          recipe: contribution.recipe,
          score: contribution.score,
          passed: contribution.passed,
          durationMs: snapshot.durationMs,
          payload: contribution.payload,
        });
        sessionId = id;
        // persistMs: host-side write cost, recorded on the sibling metrics row
        // (separate clock from canonical durationMs).
        repo.upsertHostMetrics(id, { persistMs: Math.max(0, performance.now() - persistStart) });
        log.info?.({
          evt: 'cli.run-session.recorded',
          module: MODULE_TAG,
          tool: contribution.tool,
          sessionId: id,
          durationMs: snapshot.durationMs,
        });
      } catch (error) {
        // @swallow-ok best-effort session persistence already warned; degrade to undefined
        log.warn?.({
          evt: 'cli.run-session.record_failed',
          module: MODULE_TAG,
          tool: contribution.tool,
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      return {
        id,
        tool: contribution.tool,
        startedAt: snapshot.startedAt,
        completedAt: snapshot.completedAt,
        durationMs: snapshot.durationMs,
      };
    }

    function recordHostMetrics(metrics: StoredSessionHostMetrics): void {
      if (sessionId === undefined) return;
      const datastore = safeDatastore();
      if (!datastore) return;
      try {
        new SessionRepo(datastore).upsertHostMetrics(sessionId, metrics);
      } catch (error) {
        log.warn?.({
          evt: 'cli.run-session.host_metrics_failed',
          module: MODULE_TAG,
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    /**
     * Best-effort persist of a tool's per-run dashboard contribution
     * (host-owned-run-timing Phase 5 §7), keyed by the session id just written
     * + the contributing tool. No-op when no session row exists (no datastore,
     * or the session write itself was skipped). Never throws — a failed
     * dashboard write must never affect the run or the persisted session row.
     */
    function persistDashboard(tool: ToolShortId, dashboard: ToolDashboardContribution): void {
      if (sessionId === undefined) return;
      const datastore = safeDatastore();
      if (!datastore) return;
      try {
        new SessionRepo(datastore).saveDashboardContribution(sessionId, tool, dashboard);
      } catch (error) {
        // @swallow-ok best-effort dashboard contribution; the SessionRepo write
        // already warns, but guard the construction too.
        log.warn?.({
          evt: 'cli.run-session.dashboard_contribution_failed',
          module: MODULE_TAG,
          sessionId,
          tool,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    function completeAndPersist(
      contribution: ToolSessionContribution,
      dashboard?: ToolDashboardContribution,
    ): RecordedToolRunSession | undefined {
      const recorded = persist(contribution, lifecycle.complete());
      // Persist the per-run dashboard contribution after the session row exists
      // (it is keyed by the session id). Best-effort and additive.
      if (recorded !== undefined && dashboard !== undefined) {
        persistDashboard(contribution.tool, dashboard);
      }
      return recorded;
    }

    async function completeLiveRender(
      render: () => Promise<ToolRunCompletion | void>,
    ): Promise<ToolRunCompletion | void> {
      const ttyStart = performance.now();
      const completion = await render();
      const ttyBusyMs = Math.max(0, performance.now() - ttyStart);
      if (completion?.session) {
        completeAndPersist(completion.session, completion.dashboard);
        recordHostMetrics({ ttyBusyMs });
      }
      return completion;
    }

    return {
      lifecycle,
      record: (input) => persist(input, lifecycle.snapshot()),
      completeAndPersist,
      recordHostMetrics,
      completeLiveRender,
      sessionId: () => sessionId,
    };
  }

  return {
    beginRun() {
      invocation ??= makeInvocation();
      return invocation;
    },
    current() {
      invocation ??= makeInvocation();
      return invocation;
    },
  };
}
