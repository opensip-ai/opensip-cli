/**
 * Rust resolveCallSites — name-based catalog lookup with `impl`-block
 * receiver-type context.
 *
 * Tree-sitter has no symbol table; we resolve by simple name. For
 * each call site:
 *
 *   1. Decode the called expression. Five shapes matter:
 *      - `foo(args)`              — call target is `foo`.
 *      - `obj.method(args)`       — field_expression call target is
 *                                   the trailing `field_identifier`.
 *      - `Type::method(args)`     — scoped_identifier; target is the
 *                                   trailing identifier.
 *      - `path::to::fn(args)`     — same scoped_identifier shape.
 *      - `name!(args)`            — macro_invocation target is the
 *                                   leading identifier.
 *
 *   2. Look up matching catalog entries. For method calls
 *      (`obj.method`), we narrow by `enclosingClass` if the receiver
 *      type is statically known (literal, simple-typed local). The
 *      narrow is best-effort, NOT type-aware — we don't track types
 *      across statements. With the narrow:
 *      - 1 method match in the receiver's impl  → 'high' confidence
 *        ... actually no — even with narrowing, tree-sitter never
 *        produces 'high' for ordinary calls, because the receiver
 *        type itself is name-based. We use 'medium' for the
 *        narrowed case and 'low' for the un-narrowed case.
 *      Confidence ladder for plain calls:
 *      - 0 matches  → `to: []`, resolution `'unknown'`,    confidence `'low'`
 *      - 1 match    → `to: [hash]`, resolution `'static'`, confidence `'medium'`
 *      - N matches  → `to: [allHashes]`, resolution `'method-dispatch'`,
 *                     confidence `'low'`
 *
 *   Macros are emitted as edges with `resolution: 'unknown'` and
 *   `confidence: 'low'` since macros are rarely first-party functions
 *   in the catalog. Their value to the call-graph is letting
 *   `no-side-effect-path` see `println!` calls; the edge text carries
 *   the macro name for that match.
 *
 * Per I-4: this function does NOT mutate the input catalog.
 */

import { logger } from '@opensip-tools/core';

import { appendEdge } from '../lang-adapter/edge-helpers.js';

import type { ResolveInput, ResolveOutput } from '../lang-adapter/types.js';
import type { CallEdge, FunctionOccurrence, ResolutionStats } from '../types.js';
import type { RustParsedFile, RustParsedProject } from './parse.js';
import type Parser from 'tree-sitter';

interface MutableStats {
  totalCallSites: number;
  resolvedHigh: number;
  resolvedMedium: number;
  resolvedLow: number;
  unresolved: number;
}

interface NameIndex {
  /** All occurrences keyed by simple name (excludes module-init / arrow synthetics). */
  readonly all: ReadonlyMap<string, readonly FunctionOccurrence[]>;
  /** Methods narrowed by their `enclosingClass`. Key = enclosingClass + '::' + simpleName. */
  readonly methods: ReadonlyMap<string, readonly FunctionOccurrence[]>;
}

export function resolveCallSites(input: ResolveInput<RustParsedProject>): ResolveOutput {
  logger.info({ evt: 'graph.edges.start', module: 'graph:edges:rust' });
  const index = buildIndex(input.catalog.functions);
  const edgesByOwner = new Map<string, CallEdge[]>();
  const stats: MutableStats = {
    totalCallSites: 0,
    resolvedHigh: 0,
    resolvedMedium: 0,
    resolvedLow: 0,
    unresolved: 0,
  };

  for (const r of input.callSites) {
    const node = r.nodeRef as Parser.SyntaxNode;
    const file = r.sourceFileRef as RustParsedFile;
    if (r.kind === 'creation') {
      if (r.childHash === undefined) continue;
      pushCreationEdge(node, file, r.ownerHash, r.childHash, edgesByOwner, stats);
      continue;
    }
    pushCallEdge(node, file, r.ownerHash, index, edgesByOwner, stats);
  }

  const finalStats: ResolutionStats = {
    totalCallSites: stats.totalCallSites,
    resolvedHigh: stats.resolvedHigh,
    resolvedMedium: stats.resolvedMedium,
    resolvedLow: stats.resolvedLow,
    unresolved: stats.unresolved,
  };
  logger.info({ evt: 'graph.edges.complete', module: 'graph:edges:rust', ...finalStats });

  return { edgesByOwner, stats: finalStats };
}

function buildIndex(
  functions: Readonly<Record<string, readonly FunctionOccurrence[]>>,
): NameIndex {
  const all = new Map<string, FunctionOccurrence[]>();
  const methods = new Map<string, FunctionOccurrence[]>();
  for (const [name, occs] of Object.entries(functions)) {
    if (!occs) continue;
    if (name.startsWith('<')) continue;
    const list: FunctionOccurrence[] = all.get(name) ?? [];
    for (const o of occs) {
      list.push(o);
      if (o.enclosingClass !== null) {
        const key = `${o.enclosingClass}::${o.simpleName}`;
        const ml: FunctionOccurrence[] = methods.get(key) ?? [];
        ml.push(o);
        methods.set(key, ml);
      }
    }
    all.set(name, list);
  }
  return { all, methods };
}

function pushCallEdge(
  node: Parser.SyntaxNode,
  file: RustParsedFile,
  ownerHash: string,
  index: NameIndex,
  edgesByOwner: Map<string, CallEdge[]>,
  stats: MutableStats,
): void {
  stats.totalCallSites++;
  const target = decodeCallTarget(node);
  const startLine = node.startPosition.row + 1;
  const startCol = node.startPosition.column;
  const text = file.source.slice(node.startIndex, node.endIndex);
  const truncated = text.length > 80 ? `${text.slice(0, 77)}...` : text;
  const discarded = isReturnValueDiscarded(node);

  const edge = resolveTarget(target, index, {
    line: startLine,
    column: startCol,
    text: truncated,
    discarded,
  });
  applyStats(stats, edge);
  appendEdge(edgesByOwner, ownerHash, edge);
}

interface CallTarget {
  /** The simple name of the called function/method/macro. */
  readonly name: string;
  /** Receiver type if statically known (e.g. `Foo::bar` → `'Foo'`). */
  readonly receiverType: string | null;
  /** True for `name!(...)` macro invocations. */
  readonly isMacro: boolean;
}

function decodeCallTarget(node: Parser.SyntaxNode): CallTarget | null {
  if (node.type === 'macro_invocation') {
    const m = node.childForFieldName('macro') ?? node.namedChild(0);
    if (!m) return null;
    return { name: m.text.split('::').pop() ?? m.text, receiverType: null, isMacro: true };
  }
  if (node.type !== 'call_expression') return null;
  const fn = node.childForFieldName('function');
  if (!fn) return null;
  if (fn.type === 'identifier') {
    return { name: fn.text, receiverType: null, isMacro: false };
  }
  if (fn.type === 'field_expression') {
    const field = fn.childForFieldName('field');
    if (!field) return null;
    return { name: field.text, receiverType: null, isMacro: false };
  }
  if (fn.type === 'scoped_identifier') {
    const name = fn.childForFieldName('name') ?? fn.namedChild(fn.namedChildCount - 1);
    if (!name) return null;
    const path = fn.childForFieldName('path');
    const receiver = decodeReceiverPath(path);
    return { name: name.text, receiverType: receiver, isMacro: false };
  }
  return null;
}

function decodeReceiverPath(path: Parser.SyntaxNode | null): string | null {
  if (!path) return null;
  // For `Type::name`, path is a `type_identifier` or `identifier`.
  // For `mod::Type::name`, path is a `scoped_identifier` whose own
  // trailing component is the type. We walk down the path looking for
  // the last `type_identifier` / `identifier`.
  if (path.type === 'type_identifier' || path.type === 'identifier') return path.text;
  if (path.type === 'scoped_identifier') {
    const inner = path.childForFieldName('name') ?? path.namedChild(path.namedChildCount - 1);
    return inner ? inner.text : null;
  }
  return null;
}

function resolveTarget(
  target: CallTarget | null,
  index: NameIndex,
  loc: { readonly line: number; readonly column: number; readonly text: string; readonly discarded: boolean },
): CallEdge {
  if (target === null) {
    return { to: [], line: loc.line, column: loc.column, resolution: 'unknown', confidence: 'low', text: loc.text, discarded: loc.discarded };
  }
  // Macros: tag the edge for side-effect detection but mark unresolved.
  // The edge text carries `name!` so rules can match against the
  // primitive list (e.g. `println!`).
  if (target.isMacro) {
    return {
      to: [],
      line: loc.line,
      column: loc.column,
      resolution: 'unknown',
      confidence: 'low',
      text: `${target.name}! ${loc.text}`,
      discarded: loc.discarded,
    };
  }
  // Receiver-narrowed lookup if we have a Type::method shape.
  if (target.receiverType !== null) {
    const narrowed = index.methods.get(`${target.receiverType}::${target.name}`);
    if (narrowed && narrowed.length > 0) {
      const hashes = narrowed.map((o) => o.bodyHash);
      return {
        to: hashes,
        line: loc.line,
        column: loc.column,
        resolution: hashes.length === 1 ? 'static' : 'method-dispatch',
        confidence: 'medium',
        text: loc.text,
        discarded: loc.discarded,
      };
    }
    // Receiver was named but no method — fall through to broad name lookup.
  }
  const matches = index.all.get(target.name);
  if (!matches || matches.length === 0) {
    return { to: [], line: loc.line, column: loc.column, resolution: 'unknown', confidence: 'low', text: loc.text, discarded: loc.discarded };
  }
  if (matches.length === 1) {
    const only = matches[0];
    if (!only) {
      return { to: [], line: loc.line, column: loc.column, resolution: 'unknown', confidence: 'low', text: loc.text, discarded: loc.discarded };
    }
    return {
      to: [only.bodyHash],
      line: loc.line,
      column: loc.column,
      resolution: 'static',
      confidence: 'medium',
      text: loc.text,
      discarded: loc.discarded,
    };
  }
  return {
    to: matches.map((o) => o.bodyHash),
    line: loc.line,
    column: loc.column,
    resolution: 'method-dispatch',
    confidence: 'low',
    text: loc.text,
    discarded: loc.discarded,
  };
}

function applyStats(stats: MutableStats, edge: CallEdge): void {
  if (edge.to.length === 0) {
    stats.unresolved++;
    return;
  }
  if (edge.confidence === 'high') stats.resolvedHigh++;
  else if (edge.confidence === 'medium') stats.resolvedMedium++;
  else stats.resolvedLow++;
}

function pushCreationEdge(
  node: Parser.SyntaxNode,
  file: RustParsedFile,
  ownerHash: string,
  childHash: string,
  edgesByOwner: Map<string, CallEdge[]>,
  stats: MutableStats,
): void {
  const startLine = node.startPosition.row + 1;
  const startCol = node.startPosition.column;
  const text = file.source.slice(node.startIndex, node.endIndex);
  const truncated = text.length > 70 ? `${text.slice(0, 67)}...` : text;
  const edge: CallEdge = {
    to: [childHash],
    line: startLine,
    column: startCol,
    resolution: 'static',
    confidence: 'high',
    text: `[creates] ${truncated}`,
    discarded: false,
  };
  appendEdge(edgesByOwner, ownerHash, edge);
  stats.totalCallSites++;
  stats.resolvedHigh++;
}

/**
 * The call's return value is discarded when the call expression is the
 * entire expression of an expression_statement.
 */
function isReturnValueDiscarded(node: Parser.SyntaxNode): boolean {
  let parent: Parser.SyntaxNode | null = node.parent;
  while (parent) {
    if (parent.type === 'parenthesized_expression') {
      /* v8 ignore next 3 -- parenthesized expression wrapping; rare in
         idiomatic Rust where parens around bare calls are unusual. */
      parent = parent.parent;
      continue;
    }
    return parent.type === 'expression_statement';
  }
  /* v8 ignore next -- defensive: every call expression has a parent. */
  return false;
}
