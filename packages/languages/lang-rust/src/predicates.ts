// @fitness-ignore-file duplicate-utility-functions -- ADR-0010: the per-language tree-sitter vocabulary intentionally shares helper names across lang-* with grammar-specific implementations; consolidating would defeat the substrate design.
/**
 * v1 per-language node-kind predicates for Rust (ADR-0010). The generic
 * traversal/position helpers live in `@opensip-tools/tree-sitter`; only the
 * grammar-specific node `type` strings differ per language. Node types are from
 * the tree-sitter-rust grammar. Rust has no class or try/catch — methods are
 * `fn` items inside an `impl` block (see `isMethod` in enclosing.ts), and error
 * handling is `Result`/`?` rather than exceptions.
 */

import type { Node } from '@opensip-tools/tree-sitter'

/** A `fn` item — free functions and methods are both `function_item`. */
export const isFunction = (node: Node): boolean => node.type === 'function_item'

/** A `struct` declaration. */
export const isStruct = (node: Node): boolean => node.type === 'struct_item'

/** An `impl` block. */
export const isImpl = (node: Node): boolean => node.type === 'impl_item'

/** A line comment or a block comment. */
export const isComment = (node: Node): boolean =>
  node.type === 'line_comment' || node.type === 'block_comment'

/** A string literal. */
export const isString = (node: Node): boolean => node.type === 'string_literal'

/** An `if` expression. */
export const isConditional = (node: Node): boolean => node.type === 'if_expression'

/** A `for`, `while`, or `loop` expression. */
export const isLoop = (node: Node): boolean =>
  node.type === 'for_expression' ||
  node.type === 'while_expression' ||
  node.type === 'loop_expression'
