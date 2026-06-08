import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  UnknownLiveViewError,
  type LiveViewRenderer,
  type Logger,
} from '@opensip-tools/core';
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
  render: ReturnType<typeof vi.fn>;
  liveViews: ReturnType<typeof createLiveViewRegistry>;
  maybeOpenDashboard: ReturnType<typeof vi.fn>;
  logger: Logger;
} {
  const { log } = makeLogger();
  const liveViews = createLiveViewRegistry(log);
  return {
    render: vi.fn(() => Promise.resolve()),
    liveViews,
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

  it('emitJson writes JSON-encoded output to stdout', () => {
    const opts = makeBuildOpts();
    const { ctx } = buildToolCliContext(opts);
    const out: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    });
    try {
      ctx.emitJson({ foo: 'bar' });
    } finally {
      spy.mockRestore();
    }
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('"foo": "bar"');
    expect(out[0]).toMatch(/\n$/);
  });

  it('uses defaultLogger when no logger is supplied', () => {
    const { ctx } = buildToolCliContext({
        render: vi.fn(() => Promise.resolve()),
      liveViews: createLiveViewRegistry(),
      maybeOpenDashboard: vi.fn(() => Promise.resolve()),
    });
    expect(ctx.logger).toBeDefined();
  });
});

describe('getCurrentProjectRoot / setCurrentRunScope', () => {
  it('throws when called before scope is set', async () => {
    vi.resetModules();
    const mod = await import('../cli-context.js');
    expect(() => mod.getCurrentProjectRoot()).toThrow(/pre-action-hook|action body/);
  });

  it('returns the configured project root once the run scope is set', async () => {
    vi.resetModules();
    const mod = await import('../cli-context.js');
    const { RunScope } = await import('@opensip-tools/core');
    mod.setCurrentRunScope(
      new RunScope({
        projectContext: {
          scope: 'project',
          projectRoot: '/path/to/proj',
          walkedUp: 0,
        } as never,
      }),
    );
    expect(mod.getCurrentProjectRoot()).toBe('/path/to/proj');
  });

  it('throws when the scope is set but carries no project context', async () => {
    vi.resetModules();
    const mod = await import('../cli-context.js');
    const { RunScope } = await import('@opensip-tools/core');
    // A scope with no projectContext (e.g. a bare bootstrap scope) ⇒
    // getCurrentProjectRoot must surface the PROJECT_UNSET error.
    mod.setCurrentRunScope(new RunScope({}));
    expect(() => mod.getCurrentProjectRoot()).toThrow(/pre-action-hook resolved the context/);
  });
});

describe('setCliRegistriesForRun / getCurrentRegistriesForScope', () => {
  it('throws when read before write — bootstrap-ordering safety', async () => {
    vi.resetModules();
    const mod = await import('../cli-context.js');
    expect(() => mod.getCurrentRegistriesForScope()).toThrow(/setCliRegistriesForRun/);
  });

  it('round-trips the registries set by main()', async () => {
    vi.resetModules();
    const mod = await import('../cli-context.js');
    const core = await import('@opensip-tools/core');
    const languages = new core.LanguageRegistry();
    const tools = new core.ToolRegistry();
    mod.setCliRegistriesForRun({ languages, tools });
    const out = mod.getCurrentRegistriesForScope();
    expect(out.languages).toBe(languages);
    expect(out.tools).toBe(tools);
  });
});

describe('ToolCliContext.scope getter', () => {
  it('returns the RunScope set via setCurrentRunScope', async () => {
    vi.resetModules();
    const mod = await import('../cli-context.js');
    const { RunScope } = await import('@opensip-tools/core');
    const scope = new RunScope({
      projectContext: { scope: 'project', projectRoot: '/p', walkedUp: 0 } as never,
    });
    mod.setCurrentRunScope(scope);

    const opts = makeBuildOpts();
    const { ctx } = mod.buildToolCliContext(opts);
    expect(ctx.scope).toBe(scope);
  });
});

describe('getOrOpenDatastore', () => {
  it('throws when called before scope is set', async () => {
    vi.resetModules();
    const mod = await import('../cli-context.js');
    expect(() => mod.getOrOpenDatastore()).toThrow(/pre-action-hook|action body/);
  });

  it('throws when called in a non-project context (user scope)', async () => {
    vi.resetModules();
    const mod = await import('../cli-context.js');
    const { RunScope } = await import('@opensip-tools/core');
    const project = {
      scope: 'user',
      projectRoot: '/anywhere',
      walkedUp: 0,
    } as never;
    mod.setCurrentRunScope(
      new RunScope({
        projectContext: project,
        datastore: mod.buildDatastoreThunk(project),
      }),
    );
    expect(() => mod.getOrOpenDatastore()).toThrow(/non-project context/);
  });

  it('opens the project-local sqlite datastore and caches it across calls', async () => {
    vi.resetModules();
    const mod = await import('../cli-context.js');
    const { RunScope, resolveProjectPaths } = await import('@opensip-tools/core');

    const projectRoot = mkdtempSync(join(tmpdir(), 'opensip-clictx-ds-'));
    try {
      const project = { scope: 'project', projectRoot, walkedUp: 0 } as never;
      const thunk = mod.buildDatastoreThunk(project);
      mod.setCurrentRunScope(new RunScope({ projectContext: project, datastore: thunk }));

      const first = mod.getOrOpenDatastore();
      expect(first).toBeDefined();
      // The sqlite file lands under the resolved runtime dir.
      const dbPath = join(resolveProjectPaths(projectRoot).runtimeDir, 'datastore.sqlite');
      expect(existsSync(dbPath)).toBe(true);

      // Second access returns the SAME cached instance (no re-open).
      const second = mod.getOrOpenDatastore();
      expect(second).toBe(first);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
