/**
 * live-plane — the host's interactive live-view plane
 * (host-owned-run-timing Phase 6 §6.1).
 *
 * Two pieces:
 *  1. {@link createLiveViewRegistry} — the pure key→renderer registry backing
 *     `cli.registerLiveView`. First-writer-wins on duplicate keys; an
 *     unregistered key throws {@link UnknownLiveViewError} rather than masking a
 *     mistyped key with a static render. The host builds ONE registry per
 *     invocation (in `main()`) and hands it to the context assembler.
 *  2. {@link createLivePlane} — binds that registry to the run plane so the
 *     `cli.renderLive` seam owns the live run lifecycle (Phase 2): it times the
 *     TTY occupancy and persists the renderer's returned `session` contribution
 *     after `await render()`. The renderer no longer writes the session itself.
 *
 * The host ALWAYS supplies the {@link LiveViewContext} (carrying the run seam +
 * timer) as the renderer's second argument, so tools that call `renderLive`
 * directly (fit/sim/graph `runLiveMode`) get it without threading it themselves;
 * a renderer that declares only one parameter simply ignores the extra arg.
 */

import {
  UnknownLiveViewError,
  logger as defaultLogger,
  type LiveViewContext,
  type LiveViewRenderer,
  type Logger,
  type ToolRunCompletion,
  type ToolRunSessions,
} from '@opensip-cli/core';

import type { RunPlaneFactory } from './run-plane.js';

export interface LiveViewRegistry {
  readonly register: (key: string, renderer: LiveViewRenderer) => void;
  /**
   * Render the live view. The optional third parameter is the LiveViewContext
   * (carrying runSession) to forward as the *second* argument to the renderer
   * function itself. This lets the host dispatch site (mount) supply the
   * shared run timer without changing the public ToolCliContext.renderLive
   * (tools still call renderLive(key, args)).
   */
  readonly render: (
    key: string,
    args: unknown,
    liveContext?: LiveViewContext,
  ) => Promise<ToolRunCompletion | void>;
  readonly has: (key: string) => boolean;
}

export function createLiveViewRegistry(log: Logger = defaultLogger): LiveViewRegistry {
  const renderers = new Map<string, LiveViewRenderer>();
  return {
    register(key, renderer) {
      if (renderers.has(key)) {
        log.warn({
          evt: 'cli.live_view.duplicate',
          module: 'cli:bootstrap',
          key,
          msg: `Duplicate live-view registration for key '${key}' — first registration wins.`,
        });
        return;
      }
      renderers.set(key, renderer);
    },
    /**
     * @throws {UnknownLiveViewError} When `key` has no registered live-view renderer.
     */
    async render(key, args, liveContext) {
      const renderer = renderers.get(key);
      if (!renderer) {
        // async so the throw surfaces as a rejected promise (the contract
        // callers `await` / assert `.rejects` against).
        throw new UnknownLiveViewError(key);
      }
      // Always pass the host-supplied LiveViewContext (host-owned-run-timing
      // Phase 2): live tool commands receive it; JS safely ignores the extra arg
      // for any renderer that declares only one parameter. Return the renderer's
      // ToolRunCompletion so the host can complete the lifecycle + persist.
      return renderer(args, liveContext);
    },
    has(key) {
      return renderers.has(key);
    },
  };
}

/** Stable dependencies the live plane binds together. */
export interface LivePlaneDeps {
  /** The per-invocation registry built in `main()` and passed to the assembler. */
  readonly liveViews: LiveViewRegistry;
  /** The run plane — `renderLive` runs the render through its `completeLiveRender`. */
  readonly runPlane: RunPlaneFactory;
  /** The host run seam, used to build the default {@link LiveViewContext}. */
  readonly runSession: ToolRunSessions;
}

/** The live plane's public surface (the two `ToolCliContext` live-view seams). */
export interface LivePlane {
  readonly register: LiveViewRegistry['register'];
  readonly renderLive: (
    key: string,
    args: unknown,
    liveContext?: LiveViewContext,
  ) => Promise<ToolRunCompletion | void>;
}

export function createLivePlane(deps: LivePlaneDeps): LivePlane {
  return {
    register: deps.liveViews.register,
    // Host owns the live run lifecycle (host-owned-run-timing Phase 2): time
    // the TTY occupancy, then complete the lifecycle + persist the renderer's
    // returned `session` contribution. The host always supplies the
    // LiveViewContext (carrying the run seam + timer) so tools that call
    // renderLive directly (fit/sim/graph runLiveMode) get it without passing
    // it themselves. The renderer no longer writes the session itself.
    renderLive: (key, args, liveContext) =>
      deps.runPlane
        .current()
        .completeLiveRender(() =>
          deps.liveViews.render(key, args, liveContext ?? { runSession: deps.runSession }),
        ),
  };
}
