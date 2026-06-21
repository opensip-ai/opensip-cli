/**
 * @fileoverview Tool-contributed live-view contract.
 *
 * The live-view context handed to a renderer, the renderer signature itself,
 * and the typed error thrown for an unregistered view key. Split out of the
 * kitchen-sink `types.ts` contract hub (M6); re-exported from there so the
 * public surface is unchanged.
 */

import { ToolError, type ToolErrorOptions } from '../lib/errors.js';

import type { ToolRunCompletion, ToolRunSessions } from './tool-sessions.js';

/**
 * Context object passed as the second argument to a `LiveViewRenderer`.
 * Carries the host run seam so a live renderer reads the same lifecycle
 * (timer) the host will snapshot on completion. In the launch model the
 * renderer returns its {@link ToolRunCompletion} to the host rather than
 * calling `record` itself.
 */
export interface LiveViewContext {
  readonly runSession: ToolRunSessions;
}

/**
 * Renderer signature for a tool-contributed live view. The CLI looks up
 * the registered renderer by key when a tool calls
 * `ToolCliContext.renderLive(key, args)` and invokes it with the tool's
 * args payload.
 *
 * Renderers are tool-specific. They typically wrap an Ink `render(...)`
 * call against a stateful component (FitView, GraphView) and resolve
 * once the underlying Ink app exits.
 *
 * The `args` parameter is `unknown` at the contract layer because each
 * tool defines its own args shape; tools narrow the type inside their
 * own renderer body via a runtime cast.
 *
 * In the host-owned run-lifecycle model, the second `context` argument carries
 * the host run seam (the {@link LiveViewContext}) and is supplied by the host
 * for every live tool command. A live renderer must NOT call a generic-session
 * writer itself; instead it returns a {@link ToolRunCompletion} (or `void`)
 * once the underlying Ink app exits, and the host completes the lifecycle and
 * persists the session contribution after `await renderLive(...)`.
 */
export type LiveViewRenderer = (
  args: unknown,
  context?: LiveViewContext,
) => Promise<ToolRunCompletion | void>;

/**
 * Thrown by `ToolCliContext.renderLive(key, args)` when no renderer has
 * been registered for `key`. A typed throw is preferable to silently
 * falling back to a static render — the latter masked bugs where a tool
 * mistyped its view key.
 */
export class UnknownLiveViewError extends ToolError {
  readonly viewKey: string;

  constructor(viewKey: string, options?: ToolErrorOptions) {
    super(
      `No live view registered for key '${viewKey}'. The tool that owns '${viewKey}' must call cli.registerLiveView('${viewKey}', renderer) before its first live render (e.g. in a lazy setup hook).`,
      options?.code ?? 'UNKNOWN_LIVE_VIEW',
      options,
    );
    this.name = 'UnknownLiveViewError';
    this.viewKey = viewKey;
  }
}
