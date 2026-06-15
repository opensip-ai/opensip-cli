/**
 * Generic, grammar-agnostic node accessors + AST helpers (ADR-0010 v1
 * vocabulary). `nameOf`/`childrenOf`/`namedChildrenOf` are lifted verbatim
 * from `graph-adapter-common/walk.ts` (they operate on `Node` only, no graph
 * types). `walkNodes`/`findEnclosing` mirror the `lang-typescript` precedents
 * (`ast-utilities.walkNodes`, `function-scope.findEnclosingFunction`) over
 * tree-sitter nodes. Per-language node-kind predicates layer on top in each
 * `lang-*` package.
 */

import type { Node } from 'web-tree-sitter';

/**
 * Read the text of a node's `name` field, or `null` when absent. Every
 * grammar exposes the declared name via a `name` field on function / method /
 * class / impl nodes.
 */
export function nameOf(node: Node): string | null {
  const name = node.childForFieldName('name');
  return name ? name.text : null;
}

/**
 * `node.children` with the nulls removed. web-tree-sitter types `.children`
 * as `(Node | null)[]` (a null slot is theoretically possible mid-iteration
 * during an incremental re-parse); for our one-shot parse the slots are
 * always populated, but we filter once here so consumers get a clean `Node[]`.
 */
export function childrenOf(node: Node): Node[] {
  return node.children.filter((c): c is Node => c !== null);
}

/** `node.namedChildren` with the nulls removed. See {@link childrenOf}. */
export function namedChildrenOf(node: Node): Node[] {
  return node.namedChildren.filter((c): c is Node => c !== null);
}

/** The node's source text. */
export function nodeText(node: Node): string {
  return node.text;
}

/** 1-based line number of the node's start. */
export function getLineNumber(node: Node): number {
  return node.startPosition.row + 1;
}

/** 0-based column of the node's start. */
export function getColumn(node: Node): number {
  return node.startPosition.column;
}

/**
 * Pre-order visit of every named descendant of `root` (not `root` itself) —
 * the tree-sitter analog of `lang-typescript`'s `walkNodes`. Named children
 * are the meaningful AST nodes (punctuation/anonymous tokens excluded).
 */
export function walkNodes(root: Node, visitor: (node: Node) => void): void {
  for (const child of namedChildrenOf(root)) {
    visitor(child);
    walkNodes(child, visitor);
  }
}

/**
 * Walk ancestors of `node` (excluding `node`) and return the nearest one
 * matching `predicate`, or `null` at the root — the tree-sitter analog of
 * `lang-typescript`'s `findEnclosingFunction`. Per-language helpers compose
 * this with a node-kind predicate.
 */
export function findEnclosing(node: Node, predicate: (n: Node) => boolean): Node | null {
  let current: Node | null = node.parent;
  while (current) {
    if (predicate(current)) return current;
    current = current.parent;
  }
  return null;
}
