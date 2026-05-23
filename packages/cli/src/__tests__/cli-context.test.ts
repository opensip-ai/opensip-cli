import {
  UnknownLiveViewError,
  type LiveViewRenderer,
  type Logger,
} from '@opensip-tools/core';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildToolCliContext, createLiveViewRegistry } from '../cli-context.js';

function makeLogger(): {
  log: Logger;
  warns: unknown[];
  warnSpy: ReturnType<typeof vi.fn>;
} {
  const warns: unknown[] = [];
  const warnSpy = vi.fn((entry: unknown) => {
    warns.push(entry);
  });
  const log: Logger = {
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

function makeBuildOpts(): {
  program: Command;
  render: ReturnType<typeof vi.fn>;
  liveViews: ReturnType<typeof createLiveViewRegistry>;
  builtinLiveViews: ReadonlyMap<string, LiveViewRenderer>;
  maybeOpenDashboard: ReturnType<typeof vi.fn>;
  logger: Logger;
} {
  const { log } = makeLogger();
  const liveViews = createLiveViewRegistry(log);
  return {
    program: new Command('test'),
    render: vi.fn(() => Promise.resolve()),
    liveViews,
    builtinLiveViews: new Map(),
    maybeOpenDashboard: vi.fn(() => Promise.resolve()),
    logger: log,
  };
}

describe('buildToolCliContext', () => {
  // The factory mutates `process.exitCode` through `setExitCode` — keep
  // each test isolated by snapshotting the exit code around it.
  let savedExitCode: number | undefined;
  beforeEach(() => {
    savedExitCode = process.exitCode;
    process.exitCode = 0;
  });
  afterEach(() => {
    process.exitCode = savedExitCode;
  });

  it('setExitCode mutates the captured exit code (single write path)', () => {
    const opts = makeBuildOpts();
    const { ctx, getExitCode } = buildToolCliContext(opts);
    expect(getExitCode()).toBeUndefined();
    ctx.setExitCode(2);
    expect(getExitCode()).toBe(2);
    expect(process.exitCode).toBe(2);
  });

  it('render delegates to the injected renderer', async () => {
    const opts = makeBuildOpts();
    const { ctx } = buildToolCliContext(opts);
    const result = { type: 'help' as const };
    await ctx.render(result);
    expect(opts.render).toHaveBeenCalledWith(result);
  });

  it('renderLive routes through the live-view registry', async () => {
    const opts = makeBuildOpts();
    const renderer = vi.fn<LiveViewRenderer>(() => Promise.resolve());
    opts.liveViews.register('fake', renderer);
    const { ctx } = buildToolCliContext(opts);

    await ctx.renderLive('fake', { v: 1 });
    expect(renderer).toHaveBeenCalledWith({ v: 1 });
  });

  it('renderLive throws UnknownLiveViewError for unregistered keys', async () => {
    const opts = makeBuildOpts();
    const { ctx } = buildToolCliContext(opts);
    await expect(ctx.renderLive('missing', {})).rejects.toBeInstanceOf(UnknownLiveViewError);
  });
});
