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

import { AsyncLocalStorage } from 'node:async_hooks';

import {
  createRunLifecycle,
  deriveRunOutcome,
  generatePrefixedId,
  logger as defaultLogger,
  type Logger,
  type RecordedToolRunSession,
  type RunLifecycle,
  type RunTimingSnapshot,
  type ToolRunCompletion,
  type ToolRunSessions,
  type ToolSessionContribution,
} from '@opensip-cli/core';
import { SessionRepo } from '@opensip-cli/session-store';

import type { StoredSessionHostMetrics } from '@opensip-cli/contracts';
import type { DataStore } from '@opensip-cli/datastore';

const MODULE_TAG = 'cli:run-plane';

export interface SuiteRunContext {
  readonly suiteRunId: string;
  readonly suiteName: string;
}

const suiteContextStorage = new AsyncLocalStorage<SuiteRunContext>();

export function currentSuiteRunContext(): SuiteRunContext | undefined {
  return suiteContextStorage.getStore();
}

export function runWithSuiteRunContext<T>(ctx: SuiteRunContext, fn: () => T): T {
  return suiteContextStorage.run(ctx, fn);
}

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
   * The launch path: freeze the lifecycle (`complete()`) and persist the
   * contribution with the frozen `startedAt` / `completedAt` / `durationMs`.
   * Idempotent on the lifecycle; best-effort on persistence.
   */
  completeAndPersist(contribution: ToolSessionContribution): RecordedToolRunSession | undefined;
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
   * no-op — every first-party tool now returns a contribution (Phase 3); there
   * is no transitional generic-session writer left on the launch surface.
   */
  readonly completeRun?: (result: unknown) => void;
  /** Reset the invocation slot so a host-owned multi-step command can time the next step. */
  readonly resetRun?: () => void;
  /**
   * ADR-0054 out-of-process dispatch seam. When present AND the owning tool is
   * EXTERNAL-provenance, the command action calls this INSTEAD of invoking
   * `spec.handler(...)` in-process — the worker imports the untrusted runtime,
   * runs the handler, and this seam replays the slim result through the host
   * seams. Returns `true` when it dispatched (the action skips the in-process
   * path); `false`/absent when the tool is bundled (the action runs the handler
   * in-process as today). Bound per-tool by `mountOneTool` with the tool's
   * provenance; absent for host commands (whose lean context has no run plane).
   */
  readonly maybeDispatchExternal?: (
    commandName: string,
    opts: Record<string, unknown>,
    positionals: readonly unknown[],
  ) => Promise<boolean>;
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
  /** Drop the current invocation slot. Intended for host-owned suite step boundaries. */
  reset(): void;
}

// @graph-ignore-next-line graph:near-duplicate-function-body -- factory and invocation closure intentionally share the per-command lifecycle slot.
export function createRunPlaneFactory(deps: RunPlaneDeps): RunPlaneFactory {
  const log = deps.logger ?? defaultLogger;
  // One command per CLI invocation: a single mutable invocation slot is correct.
  let invocation: RunPlaneInvocation | undefined;

  function safeDatastore(): DataStore | undefined {
    try {
      return deps.getDatastore();
    } catch (error) {
      // @swallow-ok absence of a datastore is a NORMAL control-flow signal
      // (non-project commands / tests) — the resolver throwing means the same.
      // Debug-log for diagnosability and degrade to "no datastore".
      log.debug?.({
        evt: 'cli.run-plane.datastore_unavailable',
        module: MODULE_TAG,
        error: error instanceof Error ? error.message : String(error),
      });
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
        const runOutcome = deriveRunOutcome({
          passed: contribution.passed,
          explicit: contribution.runOutcome,
        });
        repo.save({
          id,
          tool: contribution.tool,
          startedAt: snapshot.startedAt,
          completedAt: snapshot.completedAt,
          cwd: contribution.cwd,
          ...suiteSessionFields(),
          recipe: contribution.recipe,
          score: contribution.score,
          passed: contribution.passed,
          runOutcome,
          durationMs: snapshot.durationMs,
          payload: contribution.payload,
        });
        sessionId = id;
        // persistMs: host-side write cost, recorded on the sibling metrics row
        // (separate clock from canonical durationMs).
        repo.upsertHostMetrics(id, {
          persistMs: Math.max(0, performance.now() - persistStart),
        });
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

    function completeAndPersist(
      contribution: ToolSessionContribution,
    ): RecordedToolRunSession | undefined {
      return persist(contribution, lifecycle.complete());
    }

    async function completeLiveRender(
      render: () => Promise<ToolRunCompletion | void>,
    ): Promise<ToolRunCompletion | void> {
      const ttyStart = performance.now();
      const completion = await render();
      const ttyBusyMs = Math.max(0, performance.now() - ttyStart);
      if (completion?.session) {
        // Both calls are SYNCHRONOUS best-effort writes (they return a value /
        // void, not a promise); the detached-promise heuristic flags un-awaited
        // calls inside this async fn by name. Nothing to await.
        completeAndPersist(completion.session);
        recordHostMetrics({ ttyBusyMs });
      }
      return completion;
    }

    return {
      lifecycle,
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
    reset() {
      invocation = undefined;
    },
  };
}

function suiteSessionFields(): { suiteRunId?: string; suiteName?: string } {
  const suite = currentSuiteRunContext();
  return suite === undefined ? {} : { suiteRunId: suite.suiteRunId, suiteName: suite.suiteName };
}

/**
 * The public run seam (host-owned-run-timing §6.5): `timing` exposes the current
 * invocation lifecycle for display-only elapsed. There is NO public
 * generic-session writer — tools return a {@link ToolSessionContribution} (inside
 * a {@link ToolRunCompletion}) and the host run plane persists it via the action
 * hooks below. The getter lazily begins the lifecycle so a tool that reads
 * `timing` before the action hook fires still observes a live timer.
 */
export function createRunSessionSeam(factory: RunPlaneFactory): ToolRunSessions {
  return {
    get timing() {
      return factory.current().lifecycle;
    },
  };
}

/**
 * The internal run-lifecycle hooks the command-mount dispatch reads (via cast,
 * like `runSession`) to mark the lifecycle boundaries. `beginRun` starts the
 * lifecycle at the command-action boundary (after RunScope entry, before the
 * handler); `completeRun` freezes + persists when the handler returned a
 * {@link ToolRunCompletion} carrying a session contribution. A plain
 * `CommandResult` (no `session`) is a no-op.
 */
export function createRunActionHooks(factory: RunPlaneFactory): RunActionHooks {
  return {
    beginRun: () => {
      factory.beginRun();
    },
    completeRun: (result) => {
      const completion = result as ToolRunCompletion | undefined;
      const session = completion?.session;
      // host-owned-run-timing Phase 3: the host freezes the lifecycle and
      // persists the returned session contribution. Best-effort.
      if (session) factory.current().completeAndPersist(session);
    },
    resetRun: () => {
      factory.reset();
    },
  };
}
