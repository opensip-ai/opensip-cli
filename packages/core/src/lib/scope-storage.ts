/**
 * AsyncLocalStorage seam for {@link RunScope} — extracted from run-scope.ts
 * to keep the RunScope module under the file-length soft gate.
 *
 * The scope WRITERS live here because their guards throw typed errors. The reader
 * (`currentScope`) and the ALS container itself live in `scope-storage-read.ts`, which imports
 * nothing, so the error kernel can resolve a definition against the per-run catalog registry
 * without a cycle. `currentScope` is re-exported below so existing importers are untouched.
 */

import { coreErrorCatalog } from './errors/core-error-catalog.js';
import { SystemError } from './errors.js';
import { currentScope, scopeStorage } from './scope-storage-read.js';

import type { RunScope } from './run-scope-class.js';
import type { AsyncLocalStorage } from 'node:async_hooks';

export { currentScope } from './scope-storage-read.js';

/** Registered replacement for the un-catalogued `CORE.SCOPE.REENTRANT` literal. */
const SCOPE_REENTRANT = coreErrorCatalog.require('CORE.SCOPE.REENTRANT');

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
  const current = currentScope();
  if (current !== undefined && current !== scope) {
    throw new SystemError(
      'enterScope called while a different scope is already current. ' +
        'Concurrent or nested work must use runWithScope(scope, fn), not a shared enterScope.',
      { code: SCOPE_REENTRANT.code, definition: SCOPE_REENTRANT },
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
