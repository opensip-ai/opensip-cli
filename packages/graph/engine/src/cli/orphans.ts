/**
 * `graph orphans` — list orphan subtrees (the deletable slices).
 *
 * Thin wrapper over the orphan-subtree rule. Returns the subtrees as
 * structured data for tabular / JSON output. The graph CLI's main action
 * also surfaces this rule, but a dedicated subcommand reduces friction
 * for the "tech-debt cleanup" workflow.
 */

import { evaluateOrphanSubtree } from '../analysis/rules/orphan-subtree.js';

import { runGraph } from './run.js';

export interface OrphanEntry {
  readonly filePath: string;
  readonly line: number;
  readonly subtreeSize: number;
  readonly subtreeLines: number;
  readonly subtreeFunctions: readonly string[];
  readonly confidence: 'high' | 'medium' | 'low';
}

export interface ExecuteOrphansArgs {
  readonly cwd: string;
  readonly noCache: boolean;
}

export interface ExecuteOrphansResult {
  readonly orphans: readonly OrphanEntry[];
}

export async function executeOrphans(args: ExecuteOrphansArgs): Promise<ExecuteOrphansResult> {
  const { catalog } = await runGraph({ cwd: args.cwd, noCache: args.noCache });
  const findings = evaluateOrphanSubtree(catalog);
  const orphans: OrphanEntry[] = findings.map((f) => {
    const m = f.metadata as
      | { subtreeSize?: number; subtreeLines?: number; subtreeFunctions?: readonly string[]; confidence?: 'high' | 'medium' | 'low' }
      | undefined;
    return {
      filePath: f.filePath ?? '',
      line: f.line ?? 0,
      subtreeSize: m?.subtreeSize ?? 1,
      subtreeLines: m?.subtreeLines ?? 0,
      subtreeFunctions: m?.subtreeFunctions ?? [],
      confidence: m?.confidence ?? 'high',
    };
  });
  return { orphans };
}
