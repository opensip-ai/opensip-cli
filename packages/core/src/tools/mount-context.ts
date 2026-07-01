/**
 * Mount-plane context contracts — the narrow structural subsets of
 * {@link ToolCliContext} the host mount layer wires when mounting a
 * {@link CommandSpec}. Kept beside the full runtime context (`cli-context.ts`)
 * so the mount plane's dependency surface is documented on its own (ADR-0051 /
 * P1-F6). Tool handlers still receive the full `ToolCliContext`.
 */

import type { ToolCliContext } from './cli-context.js';

/**
 * Structural subset of {@link ToolCliContext} the host mount layer actually
 * touches when wiring a `CommandSpec` — render/exit/output/live-view emitters
 * only. Tool handlers still receive the full `ToolCliContext`; this type
 * documents the mount plane's dependency so host commands can mount with a
 * leaner context.
 *
 * Internal run-lifecycle hooks (`beginRun`, `completeRun`, …) are NOT members —
 * they live on a separate host-only hooks object the composition root passes to
 * `mountCommandSpec` alongside this context.
 */
export interface CommandMountContext {
  readonly render: ToolCliContext['render'];
  readonly setExitCode: ToolCliContext['setExitCode'];
  readonly reportFailure?: ToolCliContext['reportFailure'];
  readonly emitEnvelope?: ToolCliContext['emitEnvelope'];
  readonly emitJson?: ToolCliContext['emitJson'];
  readonly emitError?: ToolCliContext['emitError'];
  readonly emitRaw?: ToolCliContext['emitRaw'];
  readonly renderLive?: ToolCliContext['renderLive'];
  /** Threaded for `output:'live-view'` dispatch; absent on lean host contexts. */
  readonly runSession?: ToolCliContext['runSession'];
}

/**
 * Structural subset for live-view registration and dispatch callbacks.
 * `registerLiveView` is first-writer-wins; `renderLive` owns the TTY lifecycle.
 */
export interface LiveViewMountContext {
  readonly registerLiveView: ToolCliContext['registerLiveView'];
  readonly renderLive: ToolCliContext['renderLive'];
  readonly runSession: ToolCliContext['runSession'];
  readonly setExitCode: ToolCliContext['setExitCode'];
}
