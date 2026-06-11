/**
 * Graph language-adapter registry — per-RunScope.
 *
 * Each `RunScope` owns its own adapter registry (Item 1 / D7). The
 * graph tool's `contributeScope` hook constructs a fresh registry per CLI
 * invocation and attaches it to `scope.graph.adapters`.
 *
 * Built on the kernel's unified `Registry<T>` with
 * `duplicatePolicy: 'overwrite'` — re-registering an adapter with the
 * same `id` overwrites the incumbent. That's intentional: a host
 * application can swap an adapter in tests, and the file's prior
 * incarnation documented this contract explicitly.
 *
 * Public API:
 *   - `GraphAdapterRegistry`         — the registry class.
 *   - `createAdapterRegistry()`      — factory used by `contributeScope`.
 *   - `currentAdapterRegistry()`     — reads the scope-bound instance.
 *   - `pickAdapter()`                — compatibility helper that routes the
 *     scope-bound instance through GraphAdapterSelector.
 */

import { Registry, currentScope, type Registerable } from '@opensip-tools/core';

import { GraphAdapterSelector } from './selector.js';

import type { GraphLanguageAdapter } from './types.js';

export interface RegisterableAdapter extends Registerable {
  readonly id: string;
  readonly name: string;
  readonly adapter: GraphLanguageAdapter;
}

/**
 * Per-RunScope adapter registry. Wraps the kernel `Registry<T>` with
 * the graph-specific `register` / `pick` surface.
 */
export class GraphAdapterRegistry {
  private readonly inner = new Registry<RegisterableAdapter>({
    module: 'graph:lang-adapter',
    duplicatePolicy: 'overwrite',
    evtPrefix: 'graph.lang_adapter.registry',
  });

  /**
   * Register an adapter by its `id`. Re-registering an adapter with
   * the same `id` overwrites; that's intentional so a host application
   * can swap an adapter in tests.
   */
  register(adapter: GraphLanguageAdapter): void {
    this.inner.register({ id: adapter.id, name: adapter.id, adapter });
  }

  clear(): void {
    this.inner.clear();
  }

  get size(): number {
    return this.inner.size;
  }

  getAll(): readonly RegisterableAdapter[] {
    return this.inner.getAll();
  }

  getById(id: string): RegisterableAdapter | undefined {
    return this.inner.getById(id);
  }
}

/** Factory used by the graph tool's `contributeScope` hook. */
export function createAdapterRegistry(): GraphAdapterRegistry {
  return new GraphAdapterRegistry();
}

// Adapter discovery is no longer driven through a module-level holder. The
// generic capability loader (§5.3/§4.5) discovers graph-adapter packages per
// run and routes each through the `graph-adapter` registrar into the CURRENT
// scope's adapter registry (the CLI pre-action hook drives it). There is no
// process-global discovered-adapters state.

/**
 * Read the current scope's graph adapter registry. Throws when no
 * scope is active or when the graph subscope is missing — both
 * indicate the caller is running outside the CLI's pre-action-hook (or
 * the test fixture forgot to construct + enter a scope).
 *
 * @throws {Error} When called outside `runWithScope(...)`, or when the
 *   active scope has no graph subscope.
 */
export function currentAdapterRegistry(): GraphAdapterRegistry {
  const scope = currentScope();
  if (!scope) {
    throw new Error(
      'graph: currentAdapterRegistry() called outside a RunScope. ' +
        'Wrap the call site in runWithScope (production: pre-action-hook handles ' +
        'this; tests: use makeTestScope + graphTool.contributeScope or construct a ' +
        'registry directly).',
    );
  }
  if (!scope.graph) {
    throw new Error(
      'graph: scope.graph is missing. The graph tool must be registered and ' +
        'its contributeScope hook must run before adapter reads. (production: ' +
        'bootstrap registers graphTool; tests: call graphTool.contributeScope() ' +
        'after makeTestScope.)',
    );
  }
  return scope.graph.adapters;
}

// ---------------------------------------------------------------------------
// Scope-bound helper — `pickAdapter` routes through the current scope's
// registry to select the adapter for the run.
// ---------------------------------------------------------------------------

/** Pick the adapter for the current run. See `GraphAdapterRegistry.pick`. */
export function pickAdapter(cwd?: string): GraphLanguageAdapter {
  return new GraphAdapterSelector(currentAdapterRegistry()).pick({ cwd });
}
