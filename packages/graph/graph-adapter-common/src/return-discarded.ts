/**
 * Shared "is the return value discarded?" predicate for the tree-sitter
 * adapters.
 *
 * The base shape is byte-identical across the adapters whose call sites
 * only ever discard via a bare `expression_statement` (Java, Rust): a
 * call expression's return value is discarded when the call is the entire
 * expression of an enclosing `expression_statement`. Parenthesized
 * wrappers are transparent and walked through.
 *
 * Adapters with extra discard shapes (Go's `go`/`defer` statements,
 * Python's `await` wrapper) keep their own variant — only the common
 * Java/Rust form lives here.
 */

import type { Node } from 'web-tree-sitter';

/**
 * The call's return value is discarded when the call expression is the
 * entire expression of an enclosing `expression_statement`.
 * `parenthesized_expression` wrappers are transparent.
 */
export function isReturnValueDiscarded(node: Node): boolean {
  let parent: Node | null = node.parent;
  while (parent) {
    if (parent.type === 'parenthesized_expression') {
      parent = parent.parent;
      continue;
    }
    return parent.type === 'expression_statement';
  }
  return false;
}
