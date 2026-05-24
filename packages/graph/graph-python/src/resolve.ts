/**
 * Python resolveCallSites — name-based catalog lookup.
 *
 * Tree-sitter has no symbol table, so we resolve by simple name. For
 * each call site:
 *
 *   1. Decode the called expression. Three shapes matter:
 *      - `foo(args)`               → call target is identifier `foo`
 *      - `obj.method(args)`        → call target is attribute `method`
 *      - `mod.submod.fn(args)`     → call target is attribute `fn`
 *      Other shapes (`(lambda)()`, subscript calls) are treated as
 *      unresolved.
 *
 *   2. Look up matching catalog entries by simple name. Confidence
 *      ladder:
 *      - 0 matches  → `to: []`, resolution `'unknown'`,    confidence `'low'`
 *      - 1 match    → `to: [hash]`, resolution `'static'`, confidence `'medium'`
 *      - N matches  → `to: [allHashes]`, resolution `'method-dispatch'`,
 *                     confidence `'low'` (multiple candidates means we
 *                     can't disambiguate without a symbol table)
 *
 * Confidence is mostly `'medium'`, never `'high'` — that's the
 * intrinsic price of name-based resolution. The plan §6 fidelity table
 * documents this (`orphan-subtree`: medium for tree-sitter adapters).
 *
 * Creation edges (lambda) emit a static high-confidence edge directly,
 * mirroring lang-typescript's semantics.
 *
 * Per I-4: this function does NOT mutate the input catalog. It builds
 * a `bodyHash → CallEdge[]` map and returns it.
 */

import { logger } from '@opensip-tools/core';
import {
  appendEdge,
  createMutableStats,
  pushCreationEdge,
  truncateForCallEdge,
} from '@opensip-tools/graph';

import type { PythonParsedFile, PythonParsedProject } from './parse.js';
import type {
  CallEdge,
  FunctionOccurrence,
  MutableStats,
  ResolutionStats,
  ResolveInput,
  ResolveOutput,
} from '@opensip-tools/graph';
import type Parser from 'tree-sitter';

function pythonPosition(node: Parser.SyntaxNode, file: PythonParsedFile): {
  readonly line: number;
  readonly column: number;
  readonly text: string;
} {
  return {
    line: node.startPosition.row + 1,
    column: node.startPosition.column,
    text: file.source.slice(node.startIndex, node.endIndex),
  };
}

export function resolveCallSites(input: ResolveInput<PythonParsedProject>): ResolveOutput {
  logger.info({ evt: 'graph.edges.start', module: 'graph:edges:python' });
  const byName = buildNameIndex(input.catalog.functions);
  const edgesByOwner = new Map<string, CallEdge[]>();
  const stats = createMutableStats();

  for (const r of input.callSites) {
    const node = r.nodeRef as Parser.SyntaxNode;
    const file = r.sourceFileRef as PythonParsedFile;
    if (r.kind === 'creation') {
      if (r.childHash === undefined) continue;
      pushCreationEdge(node, file, r.ownerHash, r.childHash, edgesByOwner, stats, pythonPosition);
      continue;
    }
    pushCallEdge(node, file, r.ownerHash, byName, edgesByOwner, stats);
  }

  const finalStats: ResolutionStats = {
    totalCallSites: stats.totalCallSites,
    resolvedHigh: stats.resolvedHigh,
    resolvedMedium: stats.resolvedMedium,
    resolvedLow: stats.resolvedLow,
    unresolved: stats.unresolved,
  };

  logger.info({
    evt: 'graph.edges.complete',
    module: 'graph:edges:python',
    ...finalStats,
  });

  return { edgesByOwner, stats: finalStats };
}

function buildNameIndex(
  functions: Readonly<Record<string, readonly FunctionOccurrence[]>>,
): ReadonlyMap<string, readonly string[]> {
  const out = new Map<string, string[]>();
  for (const [name, occs] of Object.entries(functions)) {
    if (!occs) continue;
    // Skip module-init / synthetic arrow names; only real names are
    // resolution targets.
    if (name.startsWith('<')) continue;
    const list: string[] = out.get(name) ?? [];
    for (const o of occs) list.push(o.bodyHash);
    if (list.length > 0) out.set(name, list);
  }
  return out;
}

function pushCallEdge(
  node: Parser.SyntaxNode,
  file: PythonParsedFile,
  ownerHash: string,
  byName: ReadonlyMap<string, readonly string[]>,
  edgesByOwner: Map<string, CallEdge[]>,
  stats: MutableStats,
): void {
  stats.totalCallSites++;
  const target = extractCallTargetName(node);
  const pos = pythonPosition(node, file);
  const truncated = truncateForCallEdge(pos.text);
  const discarded = isReturnValueDiscarded(node);

  const edge: CallEdge = buildPythonCallEdge(target, byName, {
    line: pos.line,
    column: pos.column,
    text: truncated,
    discarded,
  });
  appendEdge(edgesByOwner, ownerHash, edge);
  stats.apply(edge);
}

interface CallEdgeLoc {
  readonly line: number;
  readonly column: number;
  readonly text: string;
  readonly discarded: boolean;
}

function buildPythonCallEdge(
  target: string | null,
  byName: ReadonlyMap<string, readonly string[]>,
  loc: CallEdgeLoc,
): CallEdge {
  if (target === null) {
    return { to: [], ...loc, resolution: 'unknown', confidence: 'low' };
  }
  const matches = byName.get(target);
  if (!matches || matches.length === 0) {
    return { to: [], ...loc, resolution: 'unknown', confidence: 'low' };
  }
  if (matches.length === 1) {
    return { to: [...matches], ...loc, resolution: 'static', confidence: 'medium' };
  }
  return { to: [...matches], ...loc, resolution: 'method-dispatch', confidence: 'low' };
}

/**
 * Decode a `call` node's target into a simple name. Returns null when
 * we don't recognize the shape (subscript call, lambda call, etc.) —
 * those become unresolved edges.
 */
function extractCallTargetName(node: Parser.SyntaxNode): string | null {
  // tree-sitter-python `call` has a `function` field for the callee.
  const fn = node.childForFieldName('function');
  if (!fn) return null;
  if (fn.type === 'identifier') return fn.text;
  if (fn.type === 'attribute') {
    const attr = fn.childForFieldName('attribute');
    return attr ? attr.text : null;
  }
  return null;
}

/**
 * The call's return value is discarded when the call expression is
 * the entire expression of an expression_statement. Mirrors
 * lang-typescript's logic for the `no-side-effect-path` rule.
 */
function isReturnValueDiscarded(node: Parser.SyntaxNode): boolean {
  let parent: Parser.SyntaxNode | null = node.parent;
  while (parent) {
    if (parent.type === 'parenthesized_expression' || parent.type === 'await') {
      parent = parent.parent;
      continue;
    }
    return parent.type === 'expression_statement';
  }
  return false;
}
