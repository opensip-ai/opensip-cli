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
import { globSync } from 'glob';

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
export function pickAdapter(cwd?: string): GraphLanguageAdapter {
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
  if (cwd !== undefined && cwd.length > 0) {
    const dominant = pickByFileDominance(cwd);
    if (dominant) return dominant;
  }
  // Deterministic fallback: prefer TypeScript when present; otherwise
  // the first id alphabetically.
  const ts = adapters.get('typescript');
  if (ts) return ts;
  /* v8 ignore start */
  const ids = [...adapters.keys()].sort();
  const id = ids[0];
  if (!id) throw new ConfigurationError('graph: registry corrupted');
  const adapter = adapters.get(id);
  if (!adapter) throw new ConfigurationError('graph: registry corrupted');
  return adapter;
  /* v8 ignore stop */
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

function pickByFileDominance(cwd: string): GraphLanguageAdapter | undefined {
  const counts = countFilesPerAdapter(cwd);
  const best = findMaxCount(counts);
  if (!best) return undefined;
  const tied = collectTies(counts, best.count);
  if (tied.length > 1) return resolveTie(tied);
  return adapters.get(best.id);
}

function countFilesPerAdapter(cwd: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const adapter of adapters.values()) {
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

function resolveTie(tied: readonly string[]): GraphLanguageAdapter | undefined {
  const preference = ['typescript', 'python', 'rust'];
  for (const pref of preference) if (tied.includes(pref)) return adapters.get(pref);
  /* v8 ignore next 2 */
  const sorted = [...tied].sort();
  return adapters.get(sorted[0] ?? '');
}

/**
 * Test-only: clear every registered adapter. The graph tool's bootstrap
 * re-registers the TypeScript adapter on the next module load.
 */
export function _clearAdaptersForTesting(): void {
  adapters.clear();
}
