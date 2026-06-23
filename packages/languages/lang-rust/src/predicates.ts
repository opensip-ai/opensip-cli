/**
 * v1 per-language node-kind predicates for Rust (ADR-0010). The generic
 * traversal/position helpers live in `@opensip-cli/tree-sitter`; only the
 * grammar-specific node `type` strings differ per language. Node types are from
 * the tree-sitter-rust grammar. Rust has no class or try/catch — methods are
 * `fn` items inside an `impl` block (see `isMethod` below), and error handling
 * is `Result`/`?` rather than exceptions.
 */

import { findEnclosing, type Node } from '@opensip-cli/tree-sitter';

/** A `fn` item — free functions and methods are both `function_item`. */
export const isFunction = (node: Node): boolean => node.type === 'function_item';

/** A `struct` declaration. */
export const isStruct = (node: Node): boolean => node.type === 'struct_item';

/** An `impl` block. */
export const isImpl = (node: Node): boolean => node.type === 'impl_item';

/** A line comment or a block comment. */
export const isComment = (node: Node): boolean =>
  node.type === 'line_comment' || node.type === 'block_comment';

/** A string literal. */
export const isString = (node: Node): boolean => node.type === 'string_literal';

/** An `if` expression. */
export const isConditional = (node: Node): boolean => node.type === 'if_expression';

/** A `for`, `while`, or `loop` expression. */
export const isLoop = (node: Node): boolean =>
  node.type === 'for_expression' ||
  node.type === 'while_expression' ||
  node.type === 'loop_expression';

/**
 * True when `node` is a method — a `fn` item whose nearest enclosing
 * function-or-impl is an `impl` block. A free function (or a `fn` nested in
 * another `fn`) is therefore not a method. Normalized into predicates.ts
 * (M10): `isMethod` lives in predicates.ts in every tree-sitter adapter.
 */
export const isMethod = (node: Node): boolean => {
  if (!isFunction(node)) return false;
  const enclosing = findEnclosing(node, (n) => isFunction(n) || isImpl(n));
  return enclosing !== null && isImpl(enclosing);
};
