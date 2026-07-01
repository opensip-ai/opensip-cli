import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  LoggerImpl,
  RunScope,
  UnknownLiveViewError,
  runWithScopeSync,
  type LiveViewRenderer,
  type Logger,
} from '@opensip-cli/core';
import { DataStoreFactory } from '@opensip-cli/datastore';
import { makeTestScope, withScope } from '@opensip-cli/test-support';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildHostDispatchCtx,
  buildToolCliContext,
  createLiveViewRegistry,
} from '../cli-context.js';

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
    // host-owned-run-timing Phase 2: the registry always forwards the (here
    // absent) LiveViewContext as the renderer's 2nd argument.
    expect(renderer).toHaveBeenCalledWith({ hello: 'world' }, undefined);
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
  maybeOpenReport: ReturnType<typeof vi.fn>;
  logger: Logger;
} {
  const { log } = makeLogger();
  const liveViews = createLiveViewRegistry(log);
  return {
    render: vi.fn(() => Promise.resolve()),
    liveViews,
    maybeOpenReport: vi.fn(() => Promise.resolve()),
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
    // host-owned-run-timing Phase 2: the host always supplies the LiveViewContext
    // (carrying the run seam) as the renderer's 2nd argument.
    expect(renderer).toHaveBeenCalledWith(
      { v: 1 },
      expect.objectContaining({ runSession: expect.anything() }),
    );
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

  it('binds logger to scope.logger inside an entered RunScope', () => {
    const opts = makeBuildOpts();
    const scopeLogger = new LoggerImpl({ level: 'debug' });
    const scope = new RunScope({ logger: scopeLogger });
    runWithScopeSync(scope, () => {
      const { ctx } = buildToolCliContext(opts);
      expect(ctx.logger).toBe(scopeLogger);
      expect(ctx.logger).toBe(scope.logger);
    });
    const { ctx } = buildToolCliContext(opts);
    expect(ctx.logger).toBe(opts.logger);
  });

  it('uses defaultLogger when no logger is supplied', () => {
    const { ctx } = buildToolCliContext({
      render: vi.fn(() => Promise.resolve()),
      liveViews: createLiveViewRegistry(),
      maybeOpenReport: vi.fn(() => Promise.resolve()),
    });
    expect(ctx.logger).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// The run-plane datastore resolver the factory hands to createRunPlaneFactory.
// It is exercised through `runActionHooks.completeRun` (host-only hooks the mount
// dispatch consumes): completeRun → completeAndPersist → the run plane's
// safeDatastore → THIS resolver. It must degrade to "no datastore" for every
// scope condition (best-effort) — never propagate.
// ---------------------------------------------------------------------------

const RESOLVER_CONTRIBUTION = {
  tool: 'fit',
  cwd: '/p',
  score: 90,
  passed: true,
  payload: {},
};

function buildCtxWithDebug(debug: ReturnType<typeof vi.fn>) {
  const base = makeBuildOpts();
  const logger: Logger = {
    debug,
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return buildToolCliContext({ ...base, logger });
}

const completeRunOf = (handle: ReturnType<typeof buildCtxWithDebug>): ((r: unknown) => void) =>
  handle.runActionHooks.completeRun ?? vi.fn();

describe('buildToolCliContext — run-plane datastore resolver', () => {
  let savedExit: number | undefined;
  beforeEach(() => {
    savedExit = process.exitCode;
    process.exitCode = 0;
  });
  afterEach(() => {
    process.exitCode = savedExit;
  });

  it('swallows a NOT_ENTERED scope and debug-logs datastore_unavailable', () => {
    const debug = vi.fn();
    const handle = buildCtxWithDebug(debug);
    // No entered scope → readScope() throws → resolver catch → undefined → no-op.
    expect(() => completeRunOf(handle)({ session: RESOLVER_CONTRIBUTION })).not.toThrow();
    expect(debug).toHaveBeenCalledWith(
      expect.objectContaining({ evt: 'cli.context.datastore_unavailable' }),
    );
  });

  it('returns undefined when the entered scope carries no datastore thunk', async () => {
    const handle = buildCtxWithDebug(vi.fn());
    await withScope(makeTestScope({}), () => {
      expect(() => completeRunOf(handle)({ session: RESOLVER_CONTRIBUTION })).not.toThrow();
    });
  });

  it('reads through the scope datastore thunk when one is present', async () => {
    const handle = buildCtxWithDebug(vi.fn());
    const ds = DataStoreFactory.open({ backend: 'memory' });
    await withScope(makeTestScope({ datastore: () => ds }), () => {
      expect(() => completeRunOf(handle)({ session: RESOLVER_CONTRIBUTION })).not.toThrow();
    });
    ds.close();
  });
});

describe('buildHostDispatchCtx (ADR-0054 M4-F hook-worker host ctx)', () => {
  it('wires the datastore-backed seams (toolState / baselines / hostPlanes) and runSession', () => {
    const { log } = makeLogger();
    const ctx = buildHostDispatchCtx(log);
    expect(typeof ctx.toolState.get).toBe('function');
    expect(typeof ctx.saveBaseline).toBe('function');
    expect(typeof ctx.compareBaseline).toBe('function');
    expect(ctx.hostPlanes).toBeDefined();
    expect(ctx.runSession.timing).toBeDefined();
  });

  it('denies the output / render / egress seams a data-gathering hook has no business calling', () => {
    const ctx = buildHostDispatchCtx();
    expect(() => ctx.registerLiveView('k', () => undefined)).toThrow(/not available/);
    expect(() => ctx.renderLive('k', {})).toThrow(/not available/);
    expect(() => ctx.deliverSignals({}, { cwd: '.' })).toThrow(/not available/);
    expect(() => ctx.writeSarif({}, 'p')).toThrow(/not available/);
    expect(() => ctx.maybeOpenReport({ openRequested: true, jsonOutput: false })).toThrow(
      /not available/,
    );
    expect(() => ctx.render({})).toThrow(/not available/);
  });
});

describe('getCurrentProjectRoot / entered scope', () => {
  it('throws when called before scope is entered', async () => {
    vi.resetModules();
    const mod = await import('../cli-context.js');
    expect(() => mod.getCurrentProjectRoot()).toThrow(
      /pre-action-hook constructed and entered it|SYSTEM.SCOPE.NOT_ENTERED/,
    );
  });

  it('returns the configured project root once inside an entered RunScope', async () => {
    vi.resetModules();
    const mod = await import('../cli-context.js');
    const { RunScope, runWithScopeSync } = await import('@opensip-cli/core');
    const scope = new RunScope({
      projectContext: {
        scope: 'project',
        projectRoot: '/path/to/proj',
        walkedUp: 0,
      } as never,
    });
    runWithScopeSync(scope, () => {
      expect(mod.getCurrentProjectRoot()).toBe('/path/to/proj');
    });
  });

  it('throws when inside a scope that carries no project context', async () => {
    vi.resetModules();
    const mod = await import('../cli-context.js');
    const { RunScope, runWithScopeSync } = await import('@opensip-cli/core');
    // A scope with no projectContext (e.g. a bare bootstrap scope) ⇒
    // getCurrentProjectRoot must surface the PROJECT_UNSET error.
    const scope = new RunScope({});
    runWithScopeSync(scope, () => {
      expect(() => mod.getCurrentProjectRoot()).toThrow(
        /pre-action-hook resolved the context|PROJECT_UNSET/,
      );
    });
  });
});

describe('admitted-tool facts ride the RunScope (no module-global handoff bag)', () => {
  it('defaults toolManifests / toolProvenance to empty arrays', async () => {
    const { RunScope } = await import('@opensip-cli/core');
    const scope = new RunScope({});
    expect(scope.toolManifests).toEqual([]);
    expect(scope.toolProvenance).toEqual([]);
  });

  it('carries the admitted-tool provenance + manifests the bootstrap stamps on it', async () => {
    const core = await import('@opensip-cli/core');
    const toolProvenance = [
      {
        id: 'plugin-a',
        version: '1.0.0',
        source: 'bundled' as const,
        packageName: '@opensip-cli/plugin-a',
        resolvedPath: '/plugins/a/package.json',
        manifestHash: 'hash-a',
      },
    ];
    const toolManifests = [
      {
        kind: 'tool' as const,
        apiVersion: core.PLUGIN_API_VERSION,
        id: 'plugin-a',
        name: 'Plugin A',
        version: '1.0.0',
        commands: [],
      },
    ];
    const scope = new core.RunScope({ toolProvenance, toolManifests });
    // Readable directly and via currentScope() inside the entered scope — the
    // single source of truth host commands now read instead of a module global.
    expect(scope.toolProvenance).toBe(toolProvenance);
    expect(scope.toolManifests).toBe(toolManifests);
    core.runWithScopeSync(scope, () => {
      expect(core.currentScope()?.toolProvenance).toBe(toolProvenance);
      expect(core.currentScope()?.toolManifests).toBe(toolManifests);
    });
  });
});

describe('ToolCliContext.scope getter', () => {
  it('returns the RunScope from the entered scope (ALS)', async () => {
    vi.resetModules();
    const mod = await import('../cli-context.js');
    const { RunScope, runWithScopeSync } = await import('@opensip-cli/core');
    const scope = new RunScope({
      projectContext: {
        scope: 'project',
        projectRoot: '/p',
        walkedUp: 0,
      } as never,
    });

    const opts = makeBuildOpts();
    runWithScopeSync(scope, () => {
      const { ctx } = mod.buildToolCliContext(opts);
      expect(ctx.scope).toBe(scope);
    });
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
    const { RunScope, runWithScopeSync } = await import('@opensip-cli/core');
    const project = {
      scope: 'user',
      projectRoot: '/anywhere',
      walkedUp: 0,
    } as never;
    const scope = new RunScope({
      projectContext: project,
      datastore: mod.buildDatastoreThunk(project),
    });
    // Enter properly (Phase 3+); the old holder simulation no longer wires readScope.
    runWithScopeSync(scope, () => {
      expect(() => mod.getOrOpenDatastore()).toThrow(
        /non-project context|Datastore accessed in a non-project context/,
      );
    });
  });

  it('opens the project-local sqlite datastore and caches it across calls', async () => {
    vi.resetModules();
    const mod = await import('../cli-context.js');
    const { RunScope, resolveProjectPaths, runWithScopeSync } = await import('@opensip-cli/core');

    const projectRoot = mkdtempSync(join(tmpdir(), 'opensip-clictx-ds-'));
    try {
      const project = { scope: 'project', projectRoot, walkedUp: 0 } as never;
      const thunk = mod.buildDatastoreThunk(project);
      const scope = new RunScope({ projectContext: project, datastore: thunk });

      runWithScopeSync(scope, () => {
        const first = mod.getOrOpenDatastore();
        expect(first).toBeDefined();
        // The sqlite file lands under the resolved runtime dir.
        const dbPath = join(resolveProjectPaths(projectRoot).runtimeDir, 'datastore.sqlite');
        expect(existsSync(dbPath)).toBe(true);

        // Second access returns the SAME cached instance (no re-open).
        const second = mod.getOrOpenDatastore();
        expect(second).toBe(first);
      });
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
