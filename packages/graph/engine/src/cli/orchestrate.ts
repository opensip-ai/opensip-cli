/**
 * Pipeline orchestrator — threads stages 0–5 together.
 *
 * The single module that imports from multiple stages. Per spec §5,
 * the orchestrator is straight-line code; every interesting decision
 * happens inside one of the stages.
 */

import { resolveProjectPaths } from '@opensip-tools/core';

import { currentTsCompilerVersion, isCatalogValid } from '../cache/invalidate.js';
import { readCatalog } from '../cache/read.js';
import { writeCatalog } from '../cache/write.js';
import { discoverFiles } from '../pipeline/discover.js';
import { resolveEdges } from '../pipeline/edges.js';
import { buildIndexes } from '../pipeline/indexes.js';
import { buildInventory } from '../pipeline/inventory.js';
import { rules as defaultRules } from '../rules/registry.js';

import type { Catalog, GraphConfig, Indexes, ResolutionStats, Rule } from '../types.js';
import type { Signal } from '@opensip-tools/core';

export interface RunGraphInput {
  readonly cwd: string;
  readonly noCache?: boolean;
  readonly config?: GraphConfig;
  /** Override the rule set (tests, custom invocations). */
  readonly rules?: readonly Rule[];
  /** Override the tsconfig path (default: <cwd>/tsconfig.json). */
  readonly tsConfigPath?: string;
}

export interface RunGraphResult {
  readonly catalog: Catalog | null;
  readonly indexes: Indexes | null;
  readonly signals: readonly Signal[];
  readonly resolutionStats: ResolutionStats | null;
  readonly cacheHit: boolean;
}

/**
 * Run the pipeline end-to-end. Each stage runs in isolation; the
 * orchestrator wires their outputs together and consults the cache
 * before redoing stages 1+2.
 */
// eslint-disable-next-line @typescript-eslint/require-await -- async surface for future cache I/O
export async function runGraph(input: RunGraphInput): Promise<RunGraphResult> {
  const config: GraphConfig = input.config ?? {};
  const ruleSet: readonly Rule[] = input.rules ?? defaultRules;
  const paths = resolveProjectPaths(input.cwd);

  const discovery = discoverFiles({
    projectDir: input.cwd,
    tsConfigPath: input.tsConfigPath,
  });

  // Cache lookup: stages 1+2 are cached; stages 0/3/4/5 always rerun.
  const useCache = input.noCache !== true;
  let catalog: Catalog | null = useCache ? readCatalog(paths.graphCatalogPath) : null;
  let cacheHit = false;
  if (catalog) {
    const valid = isCatalogValid(catalog, {
      currentTsCompilerVersion: currentTsCompilerVersion(),
      currentTsConfigPath: discovery.tsConfigPathAbs,
    });
    if (valid) {
      cacheHit = true;
    } else {
      catalog = null;
    }
  }

  let resolutionStats: ResolutionStats | null = null;
  if (!catalog) {
    const inventory = buildInventory({
      projectDirAbs: discovery.projectDirAbs,
      files: discovery.files,
      compilerOptions: discovery.compilerOptions,
      tsConfigPathAbs: discovery.tsConfigPathAbs,
    });
    const edgeResult = resolveEdges({
      catalog: inventory.catalog,
      program: inventory.program,
      projectDirAbs: discovery.projectDirAbs,
    });
    catalog = edgeResult.catalog;
    resolutionStats = edgeResult.resolutionStats;
    if (useCache) {
      try {
        writeCatalog(paths.graphCatalogPath, catalog);
      } catch {
        // Cache write failure is non-fatal — already logged.
      }
    }
  }

  const indexes: Indexes = buildIndexes(catalog);

  const signals: Signal[] = [];
  for (const rule of ruleSet) {
    const out = rule.evaluate(catalog, indexes, config);
    signals.push(...out);
  }

  return {
    catalog,
    indexes,
    signals,
    resolutionStats,
    cacheHit,
  };
}
