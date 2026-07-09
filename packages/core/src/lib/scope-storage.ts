/**
 * AsyncLocalStorage seam for {@link RunScope} — extracted from run-scope.ts
 * to keep the RunScope module under the file-length soft gate.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import { SystemError } from './errors.js';

import type { RunScope } from './run-scope-class.js';

const SCOPE_STORAGE_KEY = Symbol.for('@opensip-cli/core/scopeStorage');

/** Process-global ALS singleton — survives duplicate @opensip-cli/core copies. */
function scopeStorage(): AsyncLocalStorage<RunScope> {
  const slot = globalThis as {
    [SCOPE_STORAGE_KEY]?: AsyncLocalStorage<RunScope>;
  };
  slot[SCOPE_STORAGE_KEY] ??= new AsyncLocalStorage<RunScope>();
  return slot[SCOPE_STORAGE_KEY];
}

/**
 * Run `fn` with `scope` bound as the current scope for everything in its
 * dynamic extent. Backed by `AsyncLocalStorage.run`, so it nests cleanly
 * and is the concurrency-safe binding: use this (never a shared
 * {@link enterScope}) for concurrent or nested in-process work — two
 * overlapping runs each see their own scope and never collide.
 */
export function runWithScope<T>(scope: RunScope, fn: () => Promise<T>): Promise<T> {
  return scopeStorage().run(scope, fn);
}

/** Synchronous variant of `runWithScope`. */
export function runWithScopeSync<T>(scope: RunScope, fn: () => T): T {
  return scopeStorage().run(scope, fn);
}

/** Bind `scope` via `enterWith` for the Commander single-command pre-action path only. */
export function enterScope(scope: RunScope): void {
  const current = scopeStorage().getStore();
  if (current !== undefined && current !== scope) {
    throw new SystemError(
      'enterScope called while a different scope is already current. ' +
        'Concurrent or nested work must use runWithScope(scope, fn), not a shared enterScope.',
      { code: 'SYSTEM.SCOPE.REENTRANT' },
    );
  }
  scopeStorage().enterWith(scope);
}

/** Clear the ambient scope slot — symmetric to {@link enterScope}; host postAction only. */
export function exitScope(): void {
  // `enterWith(undefined)` clears the slot for this async context. The storage
  // is typed `AsyncLocalStorage<RunScope>` so `getStore()` stays non-nullable at
  // read sites; the cast is the one place we exercise the runtime's documented
  // "store may be undefined" contract to reset the slot.
   
  (scopeStorage() as AsyncLocalStorage<RunScope | undefined>).enterWith(undefined);
}

/** Read the current scope. Returns undefined when called outside a runWithScope. */
export function currentScope(): RunScope | undefined {
  return scopeStorage().getStore();
}
