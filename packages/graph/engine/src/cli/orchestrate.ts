/**
 * Pipeline orchestrator — threads stages 0–5 together.
 *
 * The single module that imports from multiple stages. Per spec §5,
 * the orchestrator is straight-line code; every interesting decision
 * happens inside one of the stages.
 */

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
 * orchestrator wires their outputs together.
 */
// eslint-disable-next-line @typescript-eslint/require-await -- async surface; cache I/O lands in P6
export async function runGraph(input: RunGraphInput): Promise<RunGraphResult> {
  const config: GraphConfig = input.config ?? {};
  const ruleSet: readonly Rule[] = input.rules ?? defaultRules;

  const discovery = discoverFiles({
    projectDir: input.cwd,
    tsConfigPath: input.tsConfigPath,
  });

  const inventory = buildInventory({
    projectDirAbs: discovery.projectDirAbs,
    files: discovery.files,
    compilerOptions: discovery.compilerOptions,
    tsConfigPathAbs: discovery.tsConfigPathAbs,
  });

  // Stage 2 (edges): pass-through this phase if the function still throws.
  let catalog = inventory.catalog;
  let resolutionStats: ResolutionStats | null = null;
  try {
    const edgeResult = resolveEdges({
      catalog: inventory.catalog,
      program: inventory.program,
      projectDirAbs: discovery.projectDirAbs,
    });
    catalog = edgeResult.catalog;
    resolutionStats = edgeResult.resolutionStats;
  } catch (error) {
    // P1 phase: edges not implemented yet — leave catalog with empty calls.
    if (
      error instanceof Error &&
      error.message.includes('not implemented (Phase P2/P3)')
    ) {
      // expected — fall through.
    } else {
      throw error;
    }
  }

  // Stage 3 (indexes): pass-through if not yet implemented.
  let indexes: Indexes | null = null;
  try {
    indexes = buildIndexes(catalog);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes('not implemented (Phase P4)')
    ) {
      indexes = null;
    } else {
      throw error;
    }
  }

  // Stage 4 (rules): only run if indexes are available.
  const signals: Signal[] = [];
  if (indexes) {
    for (const rule of ruleSet) {
      const out = rule.evaluate(catalog, indexes, config);
      signals.push(...out);
    }
  }

  return {
    catalog,
    indexes,
    signals,
    resolutionStats,
    cacheHit: false,
  };
}
