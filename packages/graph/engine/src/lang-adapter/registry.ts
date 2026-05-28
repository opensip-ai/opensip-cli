/**
 * Graph language-adapter registry — per-RunScope.
 *
 * Each `RunScope` owns its own adapter registry (Item 1 / D7). The
 * graph tool's `extendScope` hook constructs a fresh registry per CLI
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
 *   - `createAdapterRegistry()`      — factory used by `extendScope`.
 *   - `currentAdapterRegistry()`     — reads the scope-bound instance.
 *   - `registerAdapter` / `pickAdapter` / `clearAdapterRegistry` —
 *     thin helpers that route through the scope-bound instance for
 *     back-compat with existing callers.
 *
 * Future PRs may auto-detect the right adapter from project files;
 * for now `pickAdapter()` returns the only registered adapter so the
 * orchestrator behaves identically to today.
 */

import { ConfigurationError, Registry, currentScope, type Registerable } from '@opensip-tools/core';
import { globSync } from 'glob';

import type { GraphLanguageAdapter } from './types.js';

interface RegisterableAdapter extends Registerable {
  readonly id: string;
  readonly name: string;
  readonly adapter: GraphLanguageAdapter;
}

/**
 * Per-RunScope adapter registry. Wraps the kernel `Registry<T>` with
 * the graph-specific `registerAdapter` / `pickAdapter` surface.
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

  /**
   * Pick the adapter for the current run.
   *
   * - Zero registered adapters → fail with a configuration error.
   * - One registered adapter   → return it.
   * - Multiple adapters        → choose by file-extension dominance in
   *   `cwd` when supplied; fall back to a deterministic preference order
   *   (TypeScript first, then Python, then alphabetical).
   *
   * The dominance heuristic is intentionally simple: count files for
   * each adapter's `fileExtensions` (recursive, ignoring common
   * non-source dirs), pick whichever has the most matches. Ties prefer
   * TypeScript so the legacy TS-only behavior is preserved when a repo
   * has both. A real `--language` CLI flag is the right long-term
   * answer; until it lands, this heuristic is the best the registry can
   * do without inspecting tool config.
   */
  pick(cwd?: string): GraphLanguageAdapter {
    if (this.inner.size === 0) {
      throw new ConfigurationError(
        'graph: no language adapter registered. The TypeScript adapter ' +
          'registers itself when @opensip-tools/graph loads; check that the ' +
          'graph tool was installed correctly.',
      );
    }
    if (this.inner.size === 1) {
      const only = this.inner.getAll()[0];
      if (!only) throw new ConfigurationError('graph: registry corrupted');
      return only.adapter;
    }
    if (cwd !== undefined && cwd.length > 0) {
      const dominant = this.pickByFileDominance(cwd);
      if (dominant) return dominant;
    }
    // Deterministic fallback: prefer TypeScript when present; otherwise
    // the first id alphabetically.
    const ts = this.inner.getById('typescript');
    if (ts) return ts.adapter;
    /* v8 ignore start */
    const ids = this.inner.getAll().map((r) => r.id).sort();
    const id = ids[0];
    if (!id) throw new ConfigurationError('graph: registry corrupted');
    const entry = this.inner.getById(id);
    if (!entry) throw new ConfigurationError('graph: registry corrupted');
    return entry.adapter;
    /* v8 ignore stop */
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

  private pickByFileDominance(cwd: string): GraphLanguageAdapter | undefined {
    const counts = this.countFilesPerAdapter(cwd);
    const best = findMaxCount(counts);
    if (!best) return undefined;
    const tied = collectTies(counts, best.count);
    if (tied.length > 1) return this.resolveTie(tied);
    return this.inner.getById(best.id)?.adapter;
  }

  private countFilesPerAdapter(cwd: string): Map<string, number> {
    const counts = new Map<string, number>();
    for (const entry of this.inner.getAll()) {
      const adapter = entry.adapter;
      if (adapter.fileExtensions.length === 0) continue;
      let total = 0;
      for (const ext of adapter.fileExtensions) {
        const trimmed = ext.startsWith('.') ? ext.slice(1) : ext;
        const matches = globSync(`**/*.${trimmed}`, {
          cwd,
          ignore: [...COUNT_EXCLUDES],
          nodir: true,
          follow: false,
        });
        total += matches.length;
      }
      counts.set(adapter.id, total);
    }
    return counts;
  }

  private resolveTie(tied: readonly string[]): GraphLanguageAdapter | undefined {
    const preference = ['typescript', 'python', 'rust'];
    for (const pref of preference) if (tied.includes(pref)) return this.inner.getById(pref)?.adapter;
    /* v8 ignore next 2 */
    const sorted = [...tied].sort();
    return this.inner.getById(sorted[0] ?? '')?.adapter;
  }
}

/** Factory used by the graph tool's `extendScope` hook. */
export function createAdapterRegistry(): GraphAdapterRegistry {
  return new GraphAdapterRegistry();
}

// ---------------------------------------------------------------------------
// Discovered-adapters holder
//
// Adapter discovery happens at CLI startup (before any RunScope exists)
// by walking node_modules for @opensip-tools/graph-* packages. With
// per-scope registries we can't register the discovered adapters
// immediately — there's no scope yet. Instead, the CLI calls
// `setDiscoveredAdapters(adapters)` once after discovery, and the
// graph tool's `extendScope` reads `getDiscoveredAdapters()` to seed
// each new scope's adapter registry.
//
// The holder is intentionally module-level (one per process). It is
// SET-ONCE (or set-many-overwrite) and per-invocation registration is
// driven through it.
// ---------------------------------------------------------------------------

let discoveredAdapters: readonly GraphLanguageAdapter[] = [];

/**
 * Stash the list of adapters discovered at CLI startup so the graph
 * tool's `extendScope` can register them into each new scope's adapter
 * registry. Called once at bootstrap; idempotent.
 */
export function setDiscoveredAdapters(adapters: readonly GraphLanguageAdapter[]): void {
  discoveredAdapters = adapters;
}

/** Read the list set by `setDiscoveredAdapters`. Defaults to empty. */
export function getDiscoveredAdapters(): readonly GraphLanguageAdapter[] {
  return discoveredAdapters;
}

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
        'this; tests: use makeTestScope + graphTool.extendScope or construct a ' +
        'registry directly).',
    );
  }
  if (!scope.graph) {
    throw new Error(
      'graph: scope.graph is missing. The graph tool must be registered and ' +
        'its extendScope hook must run before adapter reads. (production: ' +
        'bootstrap registers graphTool; tests: call graphTool.extendScope(scope) ' +
        'after makeTestScope.)',
    );
  }
  return scope.graph.adapters;
}

// ---------------------------------------------------------------------------
// Back-compat helpers — keep the existing free-function surface
// (registerAdapter, pickAdapter, clearAdapterRegistry) so callers across
// the codebase don't all need to change at once. Each routes through
// the scope-bound registry.
// ---------------------------------------------------------------------------

/**
 * Register an adapter into the current scope's registry. Convenience
 * wrapper that preserves the historical free-function surface.
 */
export function registerAdapter(adapter: GraphLanguageAdapter): void {
  currentAdapterRegistry().register(adapter);
}

/** Pick the adapter for the current run. See `GraphAdapterRegistry.pick`. */
export function pickAdapter(cwd?: string): GraphLanguageAdapter {
  return currentAdapterRegistry().pick(cwd);
}

/**
 * Clear every registered adapter in the current scope. Used by tests
 * and by host applications that need to swap the adapter set at
 * runtime.
 */
export function clearAdapterRegistry(): void {
  currentAdapterRegistry().clear();
}

const COUNT_EXCLUDES: readonly string[] = [
  '**/.venv/**',
  '**/venv/**',
  '**/__pycache__/**',
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/target/**',
];

function findMaxCount(counts: ReadonlyMap<string, number>): { id: string; count: number } | null {
  let best: { id: string; count: number } | null = null;
  for (const [id, count] of counts) {
    if (count === 0) continue;
    if (best === null || count > best.count) best = { id, count };
  }
  return best;
}

function collectTies(counts: ReadonlyMap<string, number>, target: number): readonly string[] {
  return [...counts.entries()].filter(([, c]) => c === target).map(([id]) => id);
}
