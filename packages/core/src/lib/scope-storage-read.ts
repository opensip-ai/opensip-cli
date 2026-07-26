/**
 * The ambient-scope READER, as a true leaf module.
 *
 * Reading the current scope and mutating it have very different dependency needs, and keeping
 * them in one module made the reader as expensive to import as the writer. `enterScope` throws a
 * `SystemError` when it detects re-entrancy, so the combined module imported `errors.ts` — which
 * meant anything wanting to read the current scope transitively imported the error kernel, and
 * the error kernel could not read the current scope back without a cycle.
 *
 * That mattered as soon as resolving an error definition began consulting the per-run catalog
 * registry: `errors.ts → resolve-definition.ts → scope-storage.ts → errors.ts`.
 *
 * So the reader lives here with no runtime imports at all beyond `node:async_hooks`, and the
 * writers stay in `scope-storage.ts` where importing the error kernel is free. The
 * `RunScope` import below is type-only and erases at build time.
 */

import { ambientStore } from './ambient-store.js';

import type { RunScope } from './run-scope-class.js';
import type { AsyncLocalStorage } from 'node:async_hooks';

/** The ambient store viewed as the full {@link RunScope}. */
export function scopeStorage(): AsyncLocalStorage<RunScope> {
  return ambientStore<RunScope>();
}

/** Read the current scope. Returns undefined when called outside a runWithScope. */
export function currentScope(): RunScope | undefined {
  return scopeStorage().getStore();
}
