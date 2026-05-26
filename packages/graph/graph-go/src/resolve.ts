/**
 * Go resolveCallSites — name-based catalog lookup.
 *
 * Tree-sitter has no symbol table, so we resolve by simple name. For
 * each call site:
 *
 *   1. Decode the called expression. Four shapes matter:
 *      - `foo(args)`              — identifier; target is `foo`.
 *      - `obj.Method(args)`       — selector_expression; target is the
 *                                   trailing `field_identifier`.
 *      - `pkg.Func(args)`         — same shape; AST-indistinguishable
 *                                   from method calls without a type
 *                                   checker. We use the field name.
 *      - `Type{}.method(args)`    — selector_expression on a
 *                                   composite_literal; we still extract
 *                                   the field name.
 *
 *   2. Look up matching catalog entries by simple name. Confidence
 *      ladder mirrors graph-python (no receiver-type narrowing in
 *      tree-sitter-go because the receiver type can't be known without
 *      type info):
 *      - 0 matches  → `to: []`, resolution `'unknown'`,    confidence `'low'`
 *      - 1 match    → `to: [hash]`, resolution `'static'`, confidence `'medium'`
 *      - N matches  → `to: [allHashes]`, resolution `'method-dispatch'`,
 *                     confidence `'low'`
 *
 * Per I-4: this function does NOT mutate the input catalog.
 */

import { logger } from '@opensip-tools/core';
import {
  appendEdge,
  createMutableStats,
  pushCreationEdge,
  truncateForCallEdge,
} from '@opensip-tools/graph';

import type { GoParsedFile, GoParsedProject } from './parse.js';
import type {
  CallEdge,
  FunctionOccurrence,
  MutableStats,
  ResolutionStats,
  ResolveInput,
  ResolveOutput,
} from '@opensip-tools/graph';
import type Parser from 'tree-sitter';

function goPosition(node: Parser.SyntaxNode, file: GoParsedFile): {
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

export function resolveCallSites(input: ResolveInput<GoParsedProject>): ResolveOutput {
  logger.info({ evt: 'graph.edges.start', module: 'graph:edges:go' });
  const byName = buildNameIndex(input.catalog.functions);
  const edgesByOwner = new Map<string, CallEdge[]>();
  const stats = createMutableStats();

  for (const r of input.callSites) {
    const node = r.nodeRef as Parser.SyntaxNode;
    const file = r.sourceFileRef as GoParsedFile;
    if (r.kind === 'creation') {
      if (r.childHash === undefined) continue;
      pushCreationEdge(node, file, r.ownerHash, r.childHash, edgesByOwner, stats, goPosition);
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
  logger.info({ evt: 'graph.edges.complete', module: 'graph:edges:go', ...finalStats });

  return { edgesByOwner, stats: finalStats };
}

function buildNameIndex(
  functions: Readonly<Record<string, readonly FunctionOccurrence[]>>,
): ReadonlyMap<string, readonly string[]> {
  const out = new Map<string, string[]>();
  for (const [name, occs] of Object.entries(functions)) {
    if (!occs) continue;
    if (name.startsWith('<')) continue;
    const list: string[] = out.get(name) ?? [];
    for (const o of occs) list.push(o.bodyHash);
    if (list.length > 0) out.set(name, list);
  }
  return out;
}

function pushCallEdge(
  node: Parser.SyntaxNode,
  file: GoParsedFile,
  ownerHash: string,
  byName: ReadonlyMap<string, readonly string[]>,
  edgesByOwner: Map<string, CallEdge[]>,
  stats: MutableStats,
): void {
  stats.totalCallSites++;
  const target = extractCallTargetName(node);
  const pos = goPosition(node, file);
  const truncated = truncateForCallEdge(pos.text);
  const discarded = isReturnValueDiscarded(node);

  const edge = buildGoCallEdge(target, byName, {
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

function buildGoCallEdge(
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
 * Decode a `call_expression` node's target into a simple name. Returns
 * null when we don't recognize the shape (e.g. type assertion call,
 * map index call) — those become unresolved edges.
 */
function extractCallTargetName(node: Parser.SyntaxNode): string | null {
  // tree-sitter-go `call_expression` has a `function` field for the callee.
  const fn = node.childForFieldName('function');
  if (!fn) return null;
  if (fn.type === 'identifier') return fn.text;
  if (fn.type === 'selector_expression') {
    const field = fn.childForFieldName('field');
    return field ? field.text : null;
  }
  // Other shapes (index_expression, parenthesized_expression, etc.) —
  // not common for the call-graph rules we ship today.
  return null;
}

/**
 * The call's return value is discarded when the call expression is
 * the entire expression of an expression_statement. Go's `go foo()`
 * and `defer foo()` statements also discard the return.
 */
function isReturnValueDiscarded(node: Parser.SyntaxNode): boolean {
  let parent: Parser.SyntaxNode | null = node.parent;
  while (parent) {
    if (parent.type === 'parenthesized_expression') {
      parent = parent.parent;
      continue;
    }
    return (
      parent.type === 'expression_statement' ||
      parent.type === 'go_statement' ||
      parent.type === 'defer_statement'
    );
  }
  /* v8 ignore next */
  return false;
}
