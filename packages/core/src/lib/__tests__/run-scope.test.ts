import { describe, it, expect } from 'vitest';

import { LanguageParseCache } from '../../languages/parse-cache.js';
import { LanguageRegistry } from '../../languages/registry.js';
import { ToolRegistry } from '../../tools/registry.js';
import { logger as defaultLogger } from '../logger.js';
import { RunScope, runWithScope, runWithScopeSync, currentScope } from '../run-scope.js';

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
