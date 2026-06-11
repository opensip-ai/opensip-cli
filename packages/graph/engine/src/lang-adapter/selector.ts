import { ConfigurationError, logger } from '@opensip-tools/core';
import { globSync } from 'glob';

import type { GraphLanguageAdapter } from './types.js';

export interface GraphAdapterSelectionInput {
  readonly cwd?: string;
  readonly language?: string;
}

interface GraphAdapterRegistryReader {
  readonly size: number;
  getAll(): readonly {
    readonly id: string;
    readonly adapter: GraphLanguageAdapter;
  }[];
  getById(id: string):
    | {
        readonly adapter: GraphLanguageAdapter;
      }
    | undefined;
}

/**
 * Selects the graph language adapter for a run. Kept separate from
 * GraphAdapterRegistry so registration/lookup and selection policy can evolve
 * independently as more adapters land.
 */
export class GraphAdapterSelector {
  constructor(private readonly registry: GraphAdapterRegistryReader) {}

  pick(input: GraphAdapterSelectionInput = {}): GraphLanguageAdapter {
    const language = input.language?.trim();
    if (language !== undefined && language.length > 0) {
      const entry = this.registry.getById(language);
      if (entry !== undefined) return entry.adapter;
      throw new ConfigurationError(
        `graph: language adapter '${language}' is not registered. Install @opensip-tools/graph-${language} or list it under plugins.graphAdapters in opensip-tools.config.yml.`,
      );
    }
    return this.pickImplicit(input.cwd);
  }

  private pickImplicit(cwd?: string): GraphLanguageAdapter {
    if (this.registry.size === 0) {
      throw new ConfigurationError(
        'graph: no language adapter is registered. Graph adapters ship as ' +
          'separate packages (@opensip-tools/graph-typescript, -python, ' +
          '-rust, -go, -java) and are auto-discovered from node_modules. ' +
          "Install the adapter for your project's language, or list it under " +
          'plugins.graphAdapters in opensip-tools.config.yml.',
      );
    }
    if (this.registry.size === 1) {
      const only = this.registry.getAll()[0];
      if (!only) throw new ConfigurationError('graph: registry corrupted');
      return only.adapter;
    }
    if (cwd !== undefined && cwd.length > 0) {
      const dominant = this.pickByFileDominance(cwd);
      if (dominant) return dominant;
      this.warnNoMatchingAdapter(cwd);
    }
    return this.fallbackAdapter();
  }

  private fallbackAdapter(): GraphLanguageAdapter {
    const ts = this.registry.getById('typescript');
    if (ts !== undefined) return ts.adapter;
    /* v8 ignore start */
    const ids = this.registry
      .getAll()
      .map((r) => r.id)
      .sort();
    const id = ids[0];
    if (!id) throw new ConfigurationError('graph: registry corrupted');
    const entry = this.registry.getById(id);
    if (!entry) throw new ConfigurationError('graph: registry corrupted');
    return entry.adapter;
    /* v8 ignore stop */
  }

  private warnNoMatchingAdapter(cwd: string): void {
    logger.warn({
      evt: 'graph.lang_adapter.no_match',
      module: 'graph:lang-adapter',
      msg:
        'No installed graph adapter matched any source files under the ' +
        'target; falling back to TypeScript, which may yield an empty ' +
        'result. If this project is in another language, install its ' +
        'adapter (e.g. @opensip-tools/graph-go, @opensip-tools/graph-java) ' +
        'or list it under plugins.graphAdapters in opensip-tools.config.yml.',
      registered: this.registry.getAll().map((entry) => entry.id),
      cwd,
    });
  }

  private pickByFileDominance(cwd: string): GraphLanguageAdapter | undefined {
    const counts = this.countFilesPerAdapter(cwd);
    const best = findMaxCount(counts);
    if (!best) return undefined;
    const tied = collectTies(counts, best.count);
    if (tied.length > 1) return this.resolveTie(tied);
    return this.registry.getById(best.id)?.adapter;
  }

  private countFilesPerAdapter(cwd: string): Map<string, number> {
    const counts = new Map<string, number>();
    for (const entry of this.registry.getAll()) {
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
    for (const pref of preference) {
      if (tied.includes(pref)) return this.registry.getById(pref)?.adapter;
    }
    /* v8 ignore next 2 */
    const sorted = [...tied].sort();
    return this.registry.getById(sorted[0] ?? '')?.adapter;
  }
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
