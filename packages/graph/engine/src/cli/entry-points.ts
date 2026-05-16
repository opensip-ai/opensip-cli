/**
 * `graph entry-points` — list zero-caller functions inferred as entry points.
 *
 * P3 surfaces a conservative pre-cursor: zero-caller functions in non-test,
 * non-generated files, with the same "named entry-point" allowlist that the
 * orphan rule uses. The full multi-pass entry-point inferencer (binary
 * heuristic, route handlers, name patterns, package.json#bin, externalCallers)
 * lands post-v0.1 — until then this command is a useful debugging surface.
 */

import { runGraph } from './run.js';

import type { Catalog, FunctionNode } from '../catalog/types.js';

const ENTRY_POINT_NAMES = new Set(['main', 'handler', 'register', 'default']);

export interface EntryPointEntry {
  readonly id: string;
  readonly qualifiedName: string;
  readonly filePath: string;
  readonly line: number;
  readonly heuristic: 'name-match' | 'zero-callers';
}

export interface ExecuteEntryPointsArgs {
  readonly cwd: string;
  readonly noCache: boolean;
}

export interface ExecuteEntryPointsResult {
  readonly catalogStats: { functions: number; files: number };
  readonly entryPoints: readonly EntryPointEntry[];
}

export async function executeEntryPoints(args: ExecuteEntryPointsArgs): Promise<ExecuteEntryPointsResult> {
  const { catalog } = await runGraph({ cwd: args.cwd, noCache: args.noCache });
  const entryPoints = collectEntryPoints(catalog);
  return {
    catalogStats: { functions: catalog.functions.length, files: catalog.files.length },
    entryPoints,
  };
}

function collectEntryPoints(catalog: Catalog): readonly EntryPointEntry[] {
  const callers = catalog.indexes.callers;
  const out: EntryPointEntry[] = [];

  for (const fn of catalog.functions) {
    if (fn.inTestFile || fn.definedInGenerated) continue;
    const heuristic = classify(fn, callers);
    if (!heuristic) continue;
    out.push({
      id: fn.id,
      qualifiedName: fn.qualifiedName,
      filePath: fn.filePath,
      line: fn.line,
      heuristic,
    });
  }

  out.sort((a, b) => {
    if (a.filePath !== b.filePath) return a.filePath.localeCompare(b.filePath);
    return a.line - b.line;
  });
  return out;
}

function classify(
  fn: FunctionNode,
  callers: ReadonlyMap<string, readonly string[]>,
): EntryPointEntry['heuristic'] | null {
  if (ENTRY_POINT_NAMES.has(fn.simpleName)) return 'name-match';
  const callerList = callers.get(fn.id) ?? [];
  if (callerList.length === 0 && fn.visibility === 'exported') return 'zero-callers';
  return null;
}
