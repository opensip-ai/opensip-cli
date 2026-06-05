/**
 * v1 per-language node-kind predicates for Python (ADR-0010). The generic
 * traversal/position helpers live in `@opensip-tools/tree-sitter`; only the
 * grammar-specific node `type` strings differ per language, and they live here.
 * Node types are from the tree-sitter-python grammar.
 */

import type { Node } from '@opensip-tools/tree-sitter'

/** A `def` — both top-level functions and methods are `function_definition`. */
export const isFunction = (node: Node): boolean => node.type === 'function_definition'

/** A `class` declaration. */
export const isClass = (node: Node): boolean => node.type === 'class_definition'

/** A `#` comment. */
export const isComment = (node: Node): boolean => node.type === 'comment'

/** A string literal (also covers f-strings / docstrings at the node level). */
export const isString = (node: Node): boolean => node.type === 'string'

/** An `except[ … ]:` clause — Python's error-handling node. */
export const isExcept = (node: Node): boolean => node.type === 'except_clause'

/** An `if` statement. */
export const isConditional = (node: Node): boolean => node.type === 'if_statement'

/** A `for` or `while` loop. */
export const isLoop = (node: Node): boolean =>
  node.type === 'for_statement' || node.type === 'while_statement'
