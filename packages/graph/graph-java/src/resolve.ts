/**
 * Java resolveCallSites — name-based catalog lookup.
 *
 * Tree-sitter has no symbol table, so we resolve by simple name. For
 * each call site:
 *
 *   1. Decode the called expression. Three node kinds surface as calls:
 *      - `method_invocation`            — name from the `name` field.
 *        Covers `foo(...)`, `obj.foo(...)`, `Class.foo(...)`,
 *        `this.foo(...)`, `super.foo(...)` — all have the same shape.
 *      - `object_creation_expression`   — `new Foo(...)`. The target
 *        is the type name (`Foo`), which matches the constructor's
 *        `simpleName` since constructors carry their class name.
 *      - `explicit_constructor_invocation` — `super(...)` or
 *        `this(...)` inside a constructor body. We map `super` →
 *        unresolved (parent type unknown without full lookup) and
 *        `this` → unresolved (we can't tell which sibling ctor without
 *        argument-arity matching, which is out of scope).
 *
 *   2. Look up matching catalog entries by simple name. Confidence
 *      ladder mirrors graph-python/graph-go:
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

import type { JavaParsedFile, JavaParsedProject } from './parse.js';
import type {
  CallEdge,
  FunctionOccurrence,
  MutableStats,
  ResolutionStats,
  ResolveInput,
  ResolveOutput,
} from '@opensip-tools/graph';
import type Parser from 'tree-sitter';

function javaPosition(node: Parser.SyntaxNode, file: JavaParsedFile): {
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

export function resolveCallSites(input: ResolveInput<JavaParsedProject>): ResolveOutput {
  logger.info({ evt: 'graph.edges.start', module: 'graph:edges:java' });
  const byName = buildNameIndex(input.catalog.functions);
  const edgesByOwner = new Map<string, CallEdge[]>();
  const stats = createMutableStats();

  for (const r of input.callSites) {
    const node = r.nodeRef as Parser.SyntaxNode;
    const file = r.sourceFileRef as JavaParsedFile;
    if (r.kind === 'creation') {
      if (r.childHash === undefined) continue;
      pushCreationEdge(node, file, r.ownerHash, r.childHash, edgesByOwner, stats, javaPosition);
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
  logger.info({ evt: 'graph.edges.complete', module: 'graph:edges:java', ...finalStats });

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
  file: JavaParsedFile,
  ownerHash: string,
  byName: ReadonlyMap<string, readonly string[]>,
  edgesByOwner: Map<string, CallEdge[]>,
  stats: MutableStats,
): void {
  stats.totalCallSites++;
  const target = extractCallTargetName(node);
  const pos = javaPosition(node, file);
  const truncated = truncateForCallEdge(pos.text);
  const discarded = isReturnValueDiscarded(node);

  const edge = buildJavaCallEdge(target, byName, {
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

function buildJavaCallEdge(
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
 * Decode a Java call-site node's target into a simple name. Returns
 * null when the shape isn't one we recognize.
 */
function extractCallTargetName(node: Parser.SyntaxNode): string | null {
  if (node.type === 'method_invocation') {
    const name = node.childForFieldName('name');
    return name ? name.text : null;
  }
  if (node.type === 'object_creation_expression') {
    // `new Foo(...)` — target is the type name. The `type` field holds
    // a type_identifier (`Foo`), generic_type (`Foo<T>`), or
    // scoped_type_identifier (`pkg.Foo`).
    const ty = node.childForFieldName('type');
    return ty ? decodeTypeName(ty) : null;
  }
  if (node.type === 'explicit_constructor_invocation') {
    // `super(...)` or `this(...)`. We can't disambiguate constructor
    // overloads without argument-arity matching against the catalog,
    // and `super` targets a parent class we may not have. Leave
    // unresolved (callers will see the edge with text but to=[]).
    return null;
  }
  /* v8 ignore next */
  return null;
}

function decodeTypeName(node: Parser.SyntaxNode): string | null {
  if (node.type === 'type_identifier') return node.text;
  if (node.type === 'generic_type') {
    const inner = node.childForFieldName('type') ?? node.namedChild(0);
    return inner ? decodeTypeName(inner) : null;
  }
  if (node.type === 'scoped_type_identifier') {
    // `pkg.Foo` — trailing identifier is the type.
    const last = node.namedChild(node.namedChildCount - 1);
    return last ? last.text : null;
  }
  /* v8 ignore next */
  return null;
}

/**
 * The call's return value is discarded when its parent is an
 * expression_statement.
 */
function isReturnValueDiscarded(node: Parser.SyntaxNode): boolean {
  let parent: Parser.SyntaxNode | null = node.parent;
  while (parent) {
    if (parent.type === 'parenthesized_expression') {
      parent = parent.parent;
      continue;
    }
    return parent.type === 'expression_statement';
  }
  /* v8 ignore next */
  return false;
}
