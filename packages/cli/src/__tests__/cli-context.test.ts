import {
  UnknownLiveViewError,
  type LiveViewRenderer,
  type logger as coreLogger,
} from '@opensip-tools/core';
import { describe, expect, it, vi } from 'vitest';

import { createLiveViewRegistry } from '../cli-context.js';

function makeLogger(): {
  log: typeof coreLogger;
  warns: unknown[];
  warnSpy: ReturnType<typeof vi.fn>;
} {
  const warns: unknown[] = [];
  const warnSpy = vi.fn((entry: unknown) => {
    warns.push(entry);
  });
  const log: typeof coreLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
  };
  return { log, warns, warnSpy };
}

describe('createLiveViewRegistry', () => {
  it('invokes the registered renderer when renderLive is called with the matching key', async () => {
    const { log } = makeLogger();
    const registry = createLiveViewRegistry(log);
    const renderer = vi.fn<LiveViewRenderer>(() => Promise.resolve());

    registry.register('fake-view', renderer);
    await registry.render('fake-view', { hello: 'world' });

    expect(renderer).toHaveBeenCalledOnce();
    expect(renderer).toHaveBeenCalledWith({ hello: 'world' });
  });

  it('throws UnknownLiveViewError when renderLive is called with an unknown key', async () => {
    const { log } = makeLogger();
    const registry = createLiveViewRegistry(log);

    await expect(registry.render('does-not-exist', {})).rejects.toBeInstanceOf(
      UnknownLiveViewError,
    );
    await expect(registry.render('does-not-exist', {})).rejects.toMatchObject({
      viewKey: 'does-not-exist',
      code: 'UNKNOWN_LIVE_VIEW',
    });
  });

  it('first-writer-wins on duplicate registration and emits a structured warning', async () => {
    const { log, warns, warnSpy } = makeLogger();
    const registry = createLiveViewRegistry(log);
    const first = vi.fn<LiveViewRenderer>(() => Promise.resolve());
    const second = vi.fn<LiveViewRenderer>(() => Promise.resolve());

    registry.register('fake-view', first);
    registry.register('fake-view', second);

    await registry.render('fake-view', undefined);

    expect(first).toHaveBeenCalledOnce();
    expect(second).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warns[0]).toMatchObject({
      evt: 'cli.live_view.duplicate',
      key: 'fake-view',
    });
  });

  it('isolates renderers per registry instance', async () => {
    const { log } = makeLogger();
    const a = createLiveViewRegistry(log);
    const b = createLiveViewRegistry(log);
    const renderer = vi.fn<LiveViewRenderer>(() => Promise.resolve());

    a.register('view-x', renderer);
    expect(a.has('view-x')).toBe(true);
    expect(b.has('view-x')).toBe(false);
    await expect(b.render('view-x', {})).rejects.toBeInstanceOf(UnknownLiveViewError);
  });
});
