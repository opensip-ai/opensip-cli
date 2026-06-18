/**
 * io-plane — the host's interactive + effectful I/O plane
 * (host-owned-run-timing Phase 6 §6.1).
 *
 * Merges the former egress plane (cloud sync, SARIF file sink) and live-view
 * plane (registerLiveView, renderLive) into one module — both concerns are
 * effectful host I/O that tools reach only through documented ToolCliContext
 * seams.
 */

import {
  UnknownLiveViewError,
  logger as defaultLogger,
  type LiveViewContext,
  type LiveViewRenderer,
  type Logger,
  type ToolCliContext,
  type ToolRunCompletion,
  type ToolRunSessions,
} from '@opensip-cli/core';

import { deliverEnvelope, writeEnvelopeSarif } from './deliver-envelope.js';

import type { RunPlaneFactory } from './run-plane.js';
import type { SignalEnvelope } from '@opensip-cli/contracts';

// ---------------------------------------------------------------------------
// Egress (deliverSignals, writeSarif)
// ---------------------------------------------------------------------------

/** Stable dependencies the egress plane captures. */
export interface EgressPlaneDeps {
  /** The single exit-code write path (from the output plane) — threaded into delivery. */
  readonly setExitCode: (code: number) => void;
  readonly logger?: Logger;
}

/** The egress plane's public surface (the two `ToolCliContext` egress seams). */
export type EgressPlane = Pick<ToolCliContext, 'deliverSignals' | 'writeSarif'>;

export function createEgressPlane(deps: EgressPlaneDeps): EgressPlane {
  const log = deps.logger ?? defaultLogger;
  return {
    deliverSignals: (envelope, deliverOpts) =>
      deliverEnvelope(envelope as SignalEnvelope, {
        cwd: deliverOpts.cwd,
        reportTo: deliverOpts.reportTo,
        apiKey: deliverOpts.apiKey,
        runFailed: deliverOpts.runFailed,
        setExitCode: deps.setExitCode,
        logger: log,
      }),
    writeSarif: (envelope, path) => writeEnvelopeSarif(envelope as SignalEnvelope, path),
  };
}

// ---------------------------------------------------------------------------
// Live views (registerLiveView, renderLive)
// ---------------------------------------------------------------------------

export interface LiveViewRegistry {
  readonly register: (key: string, renderer: LiveViewRenderer) => void;
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
    /** @throws {UnknownLiveViewError} When no renderer was registered for `key`. */
    async render(key, args, liveContext) {
      const renderer = renderers.get(key);
      if (!renderer) {
        throw new UnknownLiveViewError(key);
      }
      return renderer(args, liveContext);
    },
    has(key) {
      return renderers.has(key);
    },
  };
}

/** Stable dependencies the live plane binds together. */
export interface LivePlaneDeps {
  readonly liveViews: LiveViewRegistry;
  readonly runPlane: RunPlaneFactory;
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
    renderLive: (key, args, liveContext) =>
      deps.runPlane
        .current()
        .completeLiveRender(() =>
          deps.liveViews.render(key, args, liveContext ?? { runSession: deps.runSession }),
        ),
  };
}

/** Build both egress and live planes from one dependency bundle. */
export function createIoPlane(deps: {
  readonly setExitCode: (code: number) => void;
  readonly logger?: Logger;
  readonly liveViews: LiveViewRegistry;
  readonly runPlane: RunPlaneFactory;
  readonly runSession: ToolRunSessions;
}): EgressPlane & LivePlane {
  return {
    ...createEgressPlane({ setExitCode: deps.setExitCode, logger: deps.logger }),
    ...createLivePlane({
      liveViews: deps.liveViews,
      runPlane: deps.runPlane,
      runSession: deps.runSession,
    }),
  };
}
