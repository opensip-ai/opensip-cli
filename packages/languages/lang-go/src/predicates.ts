/**
 * v1 per-language node-kind predicates for Go (ADR-0010). The generic
 * traversal/position helpers live in `@opensip-tools/tree-sitter`; only the
 * grammar-specific node `type` strings differ. Node types are from the
 * tree-sitter-go grammar. Go has no class or try/catch — methods are a distinct
 * `method_declaration` (receiver syntax) and error handling is value-based.
 */

import type { Node } from '@opensip-tools/tree-sitter'

/** A function or method declaration (both are callable defs). */
export const isFunction = (node: Node): boolean =>
  node.type === 'function_declaration' || node.type === 'method_declaration'

/** A method declaration (a func with a receiver). */
export const isMethod = (node: Node): boolean => node.type === 'method_declaration'

/** A `struct` type. */
export const isStruct = (node: Node): boolean => node.type === 'struct_type'

/** A comment. */
export const isComment = (node: Node): boolean => node.type === 'comment'

/** A string literal (interpreted `"..."` or raw backtick string). */
export const isString = (node: Node): boolean =>
  node.type === 'interpreted_string_literal' || node.type === 'raw_string_literal'

/** An `if` statement. */
export const isConditional = (node: Node): boolean => node.type === 'if_statement'

/** A `for` statement (Go's only loop). */
export const isLoop = (node: Node): boolean => node.type === 'for_statement'
