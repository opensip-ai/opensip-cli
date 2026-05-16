/**
 * graph:duplicated-function-body
 *
 * Fires when two or more FunctionNodes share a content hash. The hash is
 * computed over the whitespace-collapsed function body (see ids.ts), so two
 * functions that differ only in formatting still match. Comments are NOT
 * stripped — a deliberate choice: code that differs only in commentary is
 * still duplicated logic, but we don't want to merge functions whose comments
 * actively document divergent intent. Tune in P4 if false positives accrue.
 *
 * Polymorphism: not affected — this rule is structural, not call-graph.
 *
 * Severity: warning.
 * Confidence: high (the hash is a deterministic function of the body).
 */

import type { Catalog, FunctionNode } from '../../catalog/types.js';
import type { GraphFinding } from '../types.js';

export const RULE_ID = 'graph:duplicated-function-body';

export function evaluateDuplicatedFunctionBody(catalog: Catalog): readonly GraphFinding[] {
  const out: GraphFinding[] = [];
  const byId = new Map<string, FunctionNode>();
  for (const fn of catalog.functions) byId.set(fn.id, fn);

  for (const [hash, ids] of catalog.indexes.byContentHash) {
    if (ids.length < 2) continue;
    // Skip degenerate empty bodies — every empty arrow shares a hash and we
    // don't want to drown the user in `() => {}` collisions.
    const first = byId.get(ids[0]);
    if (!first) continue;
    if (isTrivialBody(first)) continue;

    const duplicates = ids
      .map((id) => byId.get(id))
      .filter((f): f is FunctionNode => f !== undefined);
    if (duplicates.length < 2) continue;

    // Pick a stable "primary" location for the finding — the first by file/line.
    const primary = [...duplicates].sort(byLocation)[0];

    out.push({
      ruleId: RULE_ID,
      message: `Duplicate function body: ${duplicates.length} functions share content hash`,
      severity: 'warning',
      filePath: primary.filePath,
      line: primary.line,
      column: primary.column,
      metadata: {
        contentHash: hash,
        duplicates: duplicates.map((f) => ({
          id: f.id,
          qualifiedName: f.qualifiedName,
          filePath: f.filePath,
          line: f.line,
        })),
        confidence: 'high',
      },
    });
  }
  return out;
}

function isTrivialBody(fn: FunctionNode): boolean {
  // Nodes that span a single line and have no calls are usually empty
  // bodies / passthrough wrappers. Skip them.
  return fn.endLine === fn.line && fn.calls.length === 0;
}

function byLocation(a: FunctionNode, b: FunctionNode): number {
  if (a.filePath !== b.filePath) return a.filePath.localeCompare(b.filePath);
  return a.line - b.line;
}
