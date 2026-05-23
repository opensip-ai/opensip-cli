/**
 * cli-context — live-view registry implementation backing
 * `ToolCliContext.registerLiveView` / `renderLive`.
 *
 * Factored out of `index.ts` so the registry can be tested in isolation
 * without booting the full Commander program. Each tool's `register(cli)`
 * calls `cli.registerLiveView(key, renderer)`; `renderLive(key, args)`
 * looks the renderer up. An unregistered key throws
 * `UnknownLiveViewError` rather than silently falling back to a static
 * render — the latter masked bugs where a tool mistyped its view key.
 */

import {
  UnknownLiveViewError,
  logger as defaultLogger,
  type LiveViewRenderer,
  type Logger,
} from '@opensip-tools/core';

export interface LiveViewRegistry {
  readonly register: (key: string, renderer: LiveViewRenderer) => void;
  readonly render: (key: string, args: unknown) => Promise<void>;
  readonly has: (key: string) => boolean;
}

/**
 * Build a fresh live-view registry. Registration is first-writer-wins
 * (matches `ToolRegistry.register` policy) — a duplicate key triggers a
 * structured `cli.live_view.duplicate` warning via the supplied logger
 * and the second call is silently ignored.
 *
 * Returns an opaque handle so the underlying `Map` doesn't leak; the
 * CLI passes only `register` / `render` through to `ToolCliContext`.
 */
export function createLiveViewRegistry(
  log: Logger = defaultLogger,
): LiveViewRegistry {
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
    async render(key, args) {
      const renderer = renderers.get(key);
      if (!renderer) {
        throw new UnknownLiveViewError(key);
      }
      await renderer(args);
    },
    has(key) {
      return renderers.has(key);
    },
  };
}
