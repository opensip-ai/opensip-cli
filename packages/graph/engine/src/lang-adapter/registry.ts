/**
 * Graph language-adapter registry.
 *
 * Lands in PR 3 of plan docs/plans/10-graph-language-pluggability.md.
 * The registry is a process-global Map<string, GraphLanguageAdapter>.
 * Adapters register themselves at module load (typically via the
 * graph tool's `tool.ts` registering the first-party TypeScript
 * adapter).
 *
 * Future PRs may auto-detect the right adapter from project files;
 * for now `pickAdapter()` returns the only registered adapter so the
 * orchestrator behaves identically to today.
 */

import { ConfigurationError } from '@opensip-tools/core';

import type { GraphLanguageAdapter } from './types.js';

const adapters = new Map<string, GraphLanguageAdapter>();

/**
 * Register an adapter by its `id`. Re-registering an adapter with
 * the same `id` overwrites; that's intentional so a host application
 * can swap an adapter in tests.
 */
export function registerAdapter(adapter: GraphLanguageAdapter): void {
  adapters.set(adapter.id, adapter);
}

/** Look up an adapter by id. Returns undefined if not registered. */
export function findAdapter(id: string): GraphLanguageAdapter | undefined {
  return adapters.get(id);
}

/** List every registered adapter's id (for diagnostics + --help). */
export function registeredAdapterIds(): readonly string[] {
  return [...adapters.keys()].sort();
}

/**
 * Pick the adapter for the current run. PR 3 ships a trivial
 * implementation: if there is exactly one registered adapter, return
 * it; otherwise, throw a configuration error. Future PRs may inspect
 * project files to auto-detect.
 */
export function pickAdapter(): GraphLanguageAdapter {
  if (adapters.size === 0) {
    throw new ConfigurationError(
      'graph: no language adapter registered. The TypeScript adapter ' +
        'registers itself when @opensip-tools/graph loads; check that the ' +
        'graph tool was installed correctly.',
    );
  }
  if (adapters.size === 1) {
    const only = [...adapters.values()][0];
    if (!only) throw new ConfigurationError('graph: registry corrupted');
    return only;
  }
  // Multiple adapters: deterministic until auto-detection lands.
  // Prefer 'typescript' if present so the legacy TS-only behavior is
  // preserved. Adapter authors who need disambiguation should add an
  // explicit `--language` flag in a follow-up PR.
  const ts = adapters.get('typescript');
  if (ts) return ts;
  // Fallback: the first id alphabetically. Stable; lets tests reason
  // about behavior.
  const ids = [...adapters.keys()].sort();
  const id = ids[0];
  if (!id) throw new ConfigurationError('graph: registry corrupted');
  const adapter = adapters.get(id);
  if (!adapter) throw new ConfigurationError('graph: registry corrupted');
  return adapter;
}

/**
 * Test-only: clear every registered adapter. The graph tool's bootstrap
 * re-registers the TypeScript adapter on the next module load.
 */
export function _clearAdaptersForTesting(): void {
  adapters.clear();
}
