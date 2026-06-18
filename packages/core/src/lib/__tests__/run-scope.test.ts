import { describe, it, expect, vi, afterEach } from 'vitest';

import { LanguageParseCache } from '../../languages/parse-cache.js';
import { LanguageRegistry } from '../../languages/registry.js';
import { ToolRegistry } from '../../tools/registry.js';
import { SystemError } from '../errors.js';
import {
  logger as defaultLogger,
  configureLogger,
  createRunLogger,
  type LoggerImpl,
} from '../logger.js';
import {
  RunScope,
  runWithScope,
  runWithScopeSync,
  currentScope,
  currentLogger,
  enterScope,
  exitScope,
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
    expect(scope.recipeUnitConfig).toBeDefined();
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
  it('clears parseCache and recipeUnitConfig', () => {
    const scope = new RunScope();
    scope.recipeUnitConfig.set('slug-a', { foo: 1 });
    expect(scope.recipeUnitConfig.get('slug-a')).toEqual({ foo: 1 });
    scope.dispose();
    expect(scope.recipeUnitConfig.get('slug-a')).toBeUndefined();
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

  it('currentLogger returns the scoped logger and falls back to the singleton outside scope', () => {
    const scopedLogger = createRunLogger({ runId: 'RUN_scoped_logger', silent: true });
    const scope = new RunScope({ runId: 'RUN_scoped_logger', logger: scopedLogger });

    expect(currentLogger()).toBe(defaultLogger);
    expect(runWithScopeSync(scope, () => currentLogger())).toBe(scopedLogger);
    expect(currentLogger()).toBe(defaultLogger);

    scope.dispose();
  });

  // NOTE on the always-on enterScope guard (SYSTEM.SCOPE.REENTRANT):
  // the `beforeEach enterScope(freshScope)` reset-pattern tests across the
  // repo (e.g. recipes/__tests__/service.test.ts, framework/__tests__/
  // register-helpers.test.ts, and the sibling graph/sim/fitness engine
  // beforeEach blocks) need NO change — Vitest gives each `beforeEach` a clean
  // ALS store, so `currentScope()` is undefined on entry and the guard never
  // fires for them. The guard only throws on a DIFFERENT current scope.
  it('enterScope throws SYSTEM.SCOPE.REENTRANT when a different scope is already current', async () => {
    // Wrap in an outer runWithScope frame so the (would-be) enterWith only
    // affects this frame's async subtree and does not leak into the test runner.
    // The always-on guard now rejects a DIFFERENT scope: concurrent/nested work
    // must use runWithScope, not a shared enterScope (single-slot enterWith).
    const outer = new RunScope();
    const entered = new RunScope();
    await runWithScope(outer, async () => {
      expect(currentScope()).toBe(outer);
      expect(() => enterScope(entered)).toThrow(SystemError);
      try {
        enterScope(entered);
        expect.unreachable('enterScope should have thrown for a different current scope');
      } catch (error) {
        expect((error as SystemError).code).toBe('SYSTEM.SCOPE.REENTRANT');
      }
      // The current scope is unchanged — the guard threw before enterWith.
      expect(currentScope()).toBe(outer);
      await Promise.resolve();
      expect(currentScope()).toBe(outer);
    });
    outer.dispose();
    entered.dispose();
  });

  it('enterScope re-entering the SAME current scope is a no-op (does not throw)', async () => {
    // Idempotent re-entry (e.g. a retried pre-action path) must NOT trip the
    // guard — the guard only fires for a DIFFERENT current scope.
    const scope = new RunScope();
    await runWithScope(scope, () => {
      expect(currentScope()).toBe(scope);
      expect(() => enterScope(scope)).not.toThrow();
      expect(currentScope()).toBe(scope);
      return Promise.resolve();
    });
    scope.dispose();
  });

  it('enterScope binds when no scope is current (the normal single-command path)', () => {
    // Run OUTSIDE any runWithScope wrapper so currentScope() is undefined on
    // entry. This is the production single-command path (the pre-action hook):
    // entering when none is current is allowed and binds the scope. Vitest's
    // ALS isolation gives this test a clean store, so the enterWith here does
    // not leak into sibling tests.
    const scope = new RunScope();
    expect(currentScope()).toBeUndefined();
    expect(() => enterScope(scope)).not.toThrow();
    expect(currentScope()).toBe(scope);
    scope.dispose();
  });

  it('exitScope clears the ambient slot so a subsequent enterScope starts clean', () => {
    // Run OUTSIDE any runWithScope wrapper. This mirrors the postAction → next
    // command sequence in one process: enter scope1, exitScope (slot cleared),
    // then enter a DIFFERENT scope2 without tripping the re-entrancy guard.
    const scope1 = new RunScope();
    const scope2 = new RunScope();

    enterScope(scope1);
    expect(currentScope()).toBe(scope1);

    exitScope();
    expect(currentScope()).toBeUndefined();

    // A different scope now enters cleanly because the slot was cleared.
    expect(() => enterScope(scope2)).not.toThrow();
    expect(currentScope()).toBe(scope2);

    exitScope();
    scope1.dispose();
    scope2.dispose();
  });

  it('exitScope is a no-op when no scope is current', () => {
    expect(currentScope()).toBeUndefined();
    expect(() => exitScope()).not.toThrow();
    expect(currentScope()).toBeUndefined();
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
    scopeA.recipeUnitConfig.set('shared', { who: 'a' });
    scopeB.recipeUnitConfig.set('shared', { who: 'b' });

    // Each callback yields a tick before reading its scope so the two
    // chains interleave through the microtask queue. ALS must hold.
    const a = runWithScope(scopeA, async () => {
      await Promise.resolve();
      return currentScope()?.recipeUnitConfig.get('shared');
    });
    const b = runWithScope(scopeB, async () => {
      await Promise.resolve();
      return currentScope()?.recipeUnitConfig.get('shared');
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
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      stderrCalls.push(String(chunk));
      return true;
    });
    // Enable stderr output by turning on debugMode. Reset runId on the
    // singleton so the fallback isn't shadowing the scope-bound value.
    configureLogger({ debugMode: true, silent: false, runId: '' });

    const scope = new RunScope({ runId: 'RUN_scope_xyz' });
    await runWithScope(scope, () => {
      defaultLogger.info({ evt: 'test.event', msg: 'inside-scope' });
      return Promise.resolve();
    });

    const matched = stderrCalls
      .map((c) => JSON.parse(c.trim()) as { evt?: string; runId?: string })
      .find((e) => e.evt === 'test.event');
    expect(matched?.runId).toBe('RUN_scope_xyz');
    scope.dispose();
  });

  it('outside any scope, the logger falls back to its singleton-level runId', () => {
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      stderrCalls.push(String(chunk));
      return true;
    });
    configureLogger({ debugMode: true, silent: false, runId: 'RUN_singleton' });

    defaultLogger.info({ evt: 'test.outside', msg: 'no-scope-here' });

    const matched = stderrCalls
      .map((c) => JSON.parse(c.trim()) as { evt?: string; runId?: string })
      .find((e) => e.evt === 'test.outside');
    expect(matched?.runId).toBe('RUN_singleton');
  });
});

describe('RunScope — per-run logger isolation (ADR-0053)', () => {
  it('concurrent scopes use independent loggers', async () => {
    const a = createRunLogger({ runId: 'RUN_a', silent: true, debugMode: true });
    const b = createRunLogger({ runId: 'RUN_b', silent: true, debugMode: false });

    const scopeA = new RunScope({ runId: 'RUN_a', logger: a });
    const scopeB = new RunScope({ runId: 'RUN_b', logger: b });

    await Promise.all([
      runWithScope(scopeA, () => {
        expect((a as LoggerImpl).getRunId()).toBe('RUN_a');
        expect((b as LoggerImpl).getRunId()).toBe('RUN_b');
        return Promise.resolve();
      }),
      runWithScope(scopeB, () => {
        expect((a as LoggerImpl).getRunId()).toBe('RUN_a');
        expect((b as LoggerImpl).getRunId()).toBe('RUN_b');
        return Promise.resolve();
      }),
    ]);

    scopeA.dispose();
    scopeB.dispose();
  });
});

describe('RecipeUnitConfigSlot', () => {
  it('get/set/setAll/clear round-trip', () => {
    const scope = new RunScope();
    const slot = scope.recipeUnitConfig;

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
    expect(scope.recipeUnitConfig.get('nope')).toBeUndefined();
    scope.dispose();
  });
});
