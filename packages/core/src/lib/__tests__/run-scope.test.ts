import { describe, it, expect, vi, afterEach } from 'vitest';

import { LanguageParseCache } from '../../languages/parse-cache.js';
import { LanguageRegistry } from '../../languages/registry.js';
import { ToolRegistry } from '../../tools/registry.js';
import { logger as defaultLogger, configureLogger } from '../logger.js';
import {
  RunScope,
  runWithScope,
  runWithScopeSync,
  currentScope,
  enterScope,
} from '../run-scope.js';

describe('RunScope — construction', () => {
  it('default constructor produces a usable scope', () => {
    const scope = new RunScope();
    expect(scope.logger).toBe(defaultLogger);
    expect(scope.parseCache).toBeInstanceOf(LanguageParseCache);
    // Fresh empty registries by default — module-level singletons removed in T1 cleanup.
    expect(scope.tools).toBeInstanceOf(ToolRegistry);
    expect(scope.languages).toBeInstanceOf(LanguageRegistry);
    expect(scope.tools.list()).toHaveLength(0);
    expect(scope.languages.list()).toHaveLength(0);
    expect(scope.projectContext).toBeUndefined();
    expect(scope.recipeCheckConfig).toBeDefined();
    scope.dispose();
  });

  it('explicit overrides are stored verbatim', () => {
    const parseCache = new LanguageParseCache();
    const scope = new RunScope({
      logger: defaultLogger,
      parseCache,
      datastore: () => ({ kind: 'fake-store' }),
    });
    expect(scope.parseCache).toBe(parseCache);
    expect(scope.datastore()).toEqual({ kind: 'fake-store' });
    scope.dispose();
  });

  it('default datastore thunk returns undefined (no-store semantics, matching prior cli.datastore contract)', () => {
    const scope = new RunScope();
    expect(scope.datastore()).toBeUndefined();
    scope.dispose();
  });

  it('default runId is the empty string (matches prior singleton reset semantics)', () => {
    const scope = new RunScope();
    expect(scope.runId).toBe('');
    scope.dispose();
  });

  it('explicit runId is stored verbatim', () => {
    const scope = new RunScope({ runId: 'RUN_abc123' });
    expect(scope.runId).toBe('RUN_abc123');
    scope.dispose();
  });
});

describe('RunScope — dispose', () => {
  it('clears parseCache and recipeCheckConfig', () => {
    const scope = new RunScope();
    scope.recipeCheckConfig.set('slug-a', { foo: 1 });
    expect(scope.recipeCheckConfig.get('slug-a')).toEqual({ foo: 1 });
    scope.dispose();
    expect(scope.recipeCheckConfig.get('slug-a')).toBeUndefined();
  });

  it('does not throw on a never-used scope', () => {
    const scope = new RunScope();
    expect(() => scope.dispose()).not.toThrow();
  });

  it('idempotent — calling twice is safe', () => {
    const scope = new RunScope();
    scope.dispose();
    expect(() => scope.dispose()).not.toThrow();
  });
});

describe('runWithScope / currentScope', () => {
  it('currentScope returns the bound scope inside the callback', async () => {
    const scope = new RunScope();
    const captured = await runWithScope(scope, () => Promise.resolve(currentScope()));
    expect(captured).toBe(scope);
    scope.dispose();
  });

  it('currentScope returns undefined outside any runWithScope block', () => {
    expect(currentScope()).toBeUndefined();
  });

  it('enterScope sets the current scope for the rest of the async context', async () => {
    // Wrap in an outer runWithScope frame so the enterWith only affects
    // this frame's async subtree and does not leak into the test runner.
    const outer = new RunScope();
    const entered = new RunScope();
    await runWithScope(outer, async () => {
      expect(currentScope()).toBe(outer);
      enterScope(entered);
      // After enterScope, the current scope is the entered one — without
      // a callback wrapper, for the remainder of this async context.
      expect(currentScope()).toBe(entered);
      await Promise.resolve();
      expect(currentScope()).toBe(entered);
    });
    outer.dispose();
    entered.dispose();
  });

  it('nested runWithScope: inner overrides; outer is restored', async () => {
    const outer = new RunScope();
    const inner = new RunScope();
    let seenOuter: RunScope | undefined;
    let seenInner: RunScope | undefined;
    let seenAfter: RunScope | undefined;

    await runWithScope(outer, async () => {
      seenOuter = currentScope();
      await runWithScope(inner, () => {
        seenInner = currentScope();
        return Promise.resolve();
      });
      seenAfter = currentScope();
    });

    expect(seenOuter).toBe(outer);
    expect(seenInner).toBe(inner);
    expect(seenAfter).toBe(outer);
    outer.dispose();
    inner.dispose();
  });

  it('two concurrent scopes in Promise.all do not leak (ALS isolation)', async () => {
    const scopeA = new RunScope();
    const scopeB = new RunScope();
    scopeA.recipeCheckConfig.set('shared', { who: 'a' });
    scopeB.recipeCheckConfig.set('shared', { who: 'b' });

    // Each callback yields a tick before reading its scope so the two
    // chains interleave through the microtask queue. ALS must hold.
    const a = runWithScope(scopeA, async () => {
      await Promise.resolve();
      return currentScope()?.recipeCheckConfig.get('shared');
    });
    const b = runWithScope(scopeB, async () => {
      await Promise.resolve();
      return currentScope()?.recipeCheckConfig.get('shared');
    });

    const [aResult, bResult] = await Promise.all([a, b]);
    expect(aResult).toEqual({ who: 'a' });
    expect(bResult).toEqual({ who: 'b' });

    scopeA.dispose();
    scopeB.dispose();
  });

  it('runWithScopeSync provides synchronous binding', () => {
    const scope = new RunScope();
    const captured = runWithScopeSync(scope, () => currentScope());
    expect(captured).toBe(scope);
    scope.dispose();
  });
});

describe('runId — scope-bound propagation to logger event-stamping', () => {
  const stderrCalls: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    stderrCalls.length = 0;
  });

  it('scope.runId is stamped on log entries inside runWithScope', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
      stderrCalls.push(String(chunk));
      return true;
    }));
    // Enable stderr output by turning on debugMode. Reset runId on the
    // singleton so the fallback isn't shadowing the scope-bound value.
    configureLogger({ debugMode: true, silent: false, runId: '' });

    const scope = new RunScope({ runId: 'RUN_scope_xyz' });
    await runWithScope(scope, () => {
      defaultLogger.info({ evt: 'test.event', msg: 'inside-scope' });
      return Promise.resolve();
    });

    const matched = stderrCalls
      .map(c => JSON.parse(c.trim()) as { evt?: string; runId?: string })
      .find(e => e.evt === 'test.event');
    expect(matched?.runId).toBe('RUN_scope_xyz');
    scope.dispose();
  });

  it('outside any scope, the logger falls back to its singleton-level runId', () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
      stderrCalls.push(String(chunk));
      return true;
    }));
    configureLogger({ debugMode: true, silent: false, runId: 'RUN_singleton' });

    defaultLogger.info({ evt: 'test.outside', msg: 'no-scope-here' });

    const matched = stderrCalls
      .map(c => JSON.parse(c.trim()) as { evt?: string; runId?: string })
      .find(e => e.evt === 'test.outside');
    expect(matched?.runId).toBe('RUN_singleton');
  });
});

describe('RecipeCheckConfigSlot', () => {
  it('get/set/setAll/clear round-trip', () => {
    const scope = new RunScope();
    const slot = scope.recipeCheckConfig;

    expect(slot.get('missing')).toBeUndefined();

    slot.set('a', { x: 1 });
    expect(slot.get('a')).toEqual({ x: 1 });

    slot.setAll({ b: { y: 2 }, c: { z: 3 } });
    // setAll REPLACES the whole map
    expect(slot.get('a')).toBeUndefined();
    expect(slot.get('b')).toEqual({ y: 2 });
    expect(slot.get('c')).toEqual({ z: 3 });

    slot.clear();
    expect(slot.get('b')).toBeUndefined();
    expect(slot.get('c')).toBeUndefined();

    scope.dispose();
  });

  it('get returns undefined for missing slug', () => {
    const scope = new RunScope();
    expect(scope.recipeCheckConfig.get('nope')).toBeUndefined();
    scope.dispose();
  });
});
