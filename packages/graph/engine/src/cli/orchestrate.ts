/**
 * Pipeline orchestrator — threads stages 0–5 together.
 *
 * The single module that imports from multiple stages. Per spec §5,
 * the orchestrator is straight-line code; every interesting decision
 * happens inside one of the stages.
 */

import { logger, resolveProjectPaths } from '@opensip-tools/core';

import {
  computeFilesFingerprint,
  currentTsCompilerVersion,
  isCatalogValid,
} from '../cache/invalidate.js';
import { readCatalog } from '../cache/read.js';
import { writeCatalog } from '../cache/write.js';
import { discoverFiles } from '../pipeline/discover.js';
import { resolveEdges } from '../pipeline/edges.js';
import { buildIndexes } from '../pipeline/indexes.js';
import { buildInventory } from '../pipeline/inventory.js';
import { rules as defaultRules } from '../rules/registry.js';

import type { Catalog, GraphConfig, Indexes, ResolutionStats, Rule } from '../types.js';
import type { Signal } from '@opensip-tools/core';

/**
 * File-count threshold above which we emit a heap-sizing hint to stderr.
 * The OpenSIP measurement run (5476 files) OOM'd on a default 4 GB heap;
 * 1000 is conservative and gives users a chance to bump the heap before
 * the slow Stage 1 program-construction kicks in. See
 * docs/plans/graph-performance-improvements.md Phase 0.
 */
const LARGE_REPO_FILE_THRESHOLD = 1000;

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

  emitLargeRepoHint(discovery.files.length);

  // Cache lookup: stages 1+2 are cached; stages 0/3/4/5 always rerun.
  const useCache = input.noCache !== true;
  let catalog: Catalog | null = useCache ? readCatalog(paths.graphCatalogPath) : null;
  let cacheHit = false;
  if (catalog) {
    const valid = isCatalogValid(catalog, {
      currentTsCompilerVersion: currentTsCompilerVersion(),
      currentTsConfigPath: discovery.tsConfigPathAbs,
      currentFiles: discovery.files,
    });
    if (valid) {
      cacheHit = true;
    } else {
      catalog = null;
    }
  }

  let resolutionStats: ResolutionStats | null = null;
  if (!catalog) {
    // Stages 1+2 are scoped to a block so the ts.Program reference held
    // by `inventory.program` becomes unreachable as soon as edge
    // resolution finishes. With ~3000+ files the program plus its bound
    // symbol table is ~1-2 GB; freeing it before stages 3-5 (indexes,
    // rules, serialization) keeps peak resident lower. See
    // docs/plans/graph-performance-improvements.md Phase 1.
    const built = buildAndResolveCatalog(discovery);
    catalog = {
      ...built.catalog,
      filesFingerprint: computeFilesFingerprint(discovery.files),
    };
    resolutionStats = built.resolutionStats;
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

/**
 * Run Stage 1 + Stage 2 and return only the catalog and resolution
 * stats. The TypeScript Program is created inside this function and
 * does not escape — once edge resolution returns, the program is
 * unreachable from any caller, so V8 can reclaim ~1-2 GB of bound AST
 * before Stage 3 (`buildIndexes`) and the cache write run.
 */
function buildAndResolveCatalog(
  discovery: ReturnType<typeof discoverFiles>,
): { readonly catalog: Catalog; readonly resolutionStats: ResolutionStats } {
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
  return { catalog: edgeResult.catalog, resolutionStats: edgeResult.resolutionStats };
}

/**
 * On large repos, the TypeScript Program built in Stage 1 can exhaust
 * Node's default ~4 GB heap before Stage 2 starts. Emit a single hint
 * to stderr (and a structured log line) before Stage 1 runs so users
 * see actionable guidance up front instead of a V8 OOM stack 17 minutes
 * in. Below the threshold, stays silent.
 *
 * Exported for unit tests; otherwise an internal helper.
 */
export function emitLargeRepoHint(fileCount: number): void {
  if (fileCount <= LARGE_REPO_FILE_THRESHOLD) return;
  logger.warn({
    evt: 'graph.heap.largeRepoHint',
    module: 'graph:cli',
    files: fileCount,
    threshold: LARGE_REPO_FILE_THRESHOLD,
  });
  process.stderr.write(
    `graph: ${String(fileCount)} files detected (> ${String(LARGE_REPO_FILE_THRESHOLD)}). If the run OOMs, retry with NODE_OPTIONS=--max-old-space-size=8192 (or 12288 for very large monorepos).\n`,
  );
}
