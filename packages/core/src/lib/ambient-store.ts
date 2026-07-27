/**
 * The process-global `AsyncLocalStorage` container, and nothing else.
 *
 * This module has NO imports beyond `node:async_hooks` — not even type-only ones — and that is
 * the whole point. `RunScope` is the root of a large type graph (registries → tools → baseline →
 * back to the error kernel), so a module that names the `RunScope` type is not a leaf even when
 * the import erases at build time. The type-aware architecture gate counts those edges, and it
 * is right to: a type cycle is still a comprehension cycle.
 *
 * The error kernel needs to read one narrow thing out of the ambient scope — the per-run error
 * catalog index — and must not import the whole scope type to do it. So the container is
 * exposed generically here and each reader supplies the view it needs:
 *
 *   - `scope-storage-read.ts` asks for `RunScope`, the full thing.
 *   - `errors/resolve-definition.ts` asks for a three-line structural view of just the catalog
 *     lookup.
 *
 * Both get the SAME underlying storage instance, so this is one ambient scope with two typed
 * lenses, not two stores. The store still holds no run state at module level: the value flows
 * per-async-context through `runWithScope`/`enterScope`.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

const SCOPE_STORAGE_KEY = Symbol.for('@opensip-cli/core/scopeStorage');

/**
 * The one ambient store, viewed as `AsyncLocalStorage<T>`.
 *
 * Pinned on `globalThis` because pnpm's `injectWorkspacePackages` hard-links a nested
 * `@opensip-cli/core` into the virtual store: two physical copies with two separate
 * `AsyncLocalStorage` instances would split the scope in half, leaving `currentScope()`
 * undefined inside check execution and silently degrading content filters to raw.
 *
 * `T` is a caller-chosen VIEW of the same stored value, never a different store — every caller
 * must supply a type the real stored `RunScope` structurally satisfies.
 */
export function ambientStore<T>(): AsyncLocalStorage<T> {
  const slot = globalThis as { [SCOPE_STORAGE_KEY]?: AsyncLocalStorage<unknown> };
  slot[SCOPE_STORAGE_KEY] ??= new AsyncLocalStorage<unknown>();
  return slot[SCOPE_STORAGE_KEY] as AsyncLocalStorage<T>;
}
