// @fitness-ignore-file duplicate-utility-functions -- ADR-0010: the per-language tree-sitter vocabulary intentionally shares helper names across lang-* with grammar-specific implementations; consolidating would defeat the substrate design.
/**
 * v1 per-language node-kind predicates for Java (ADR-0010). The generic
 * traversal/position helpers live in `@opensip-tools/tree-sitter`; only the
 * grammar-specific node `type` strings differ. Node types are from the
 * tree-sitter-java grammar.
 */

import type { Node } from '@opensip-tools/tree-sitter'

/** A method or constructor declaration (both are callable defs). */
export const isFunction = (node: Node): boolean =>
  node.type === 'method_declaration' || node.type === 'constructor_declaration'

/** A method declaration. */
export const isMethod = (node: Node): boolean => node.type === 'method_declaration'

/** A constructor declaration. */
export const isConstructor = (node: Node): boolean => node.type === 'constructor_declaration'

/** A class declaration. */
export const isClass = (node: Node): boolean => node.type === 'class_declaration'

/** A line or block comment. */
export const isComment = (node: Node): boolean =>
  node.type === 'line_comment' || node.type === 'block_comment'

/** A string literal. */
export const isString = (node: Node): boolean => node.type === 'string_literal'

/** A `catch` clause — Java's error-handling node. */
export const isCatch = (node: Node): boolean => node.type === 'catch_clause'

/** An `if` statement. */
export const isConditional = (node: Node): boolean => node.type === 'if_statement'

/** A `for`, `while`, or enhanced-`for` (for-each) loop. */
export const isLoop = (node: Node): boolean =>
  node.type === 'for_statement' ||
  node.type === 'while_statement' ||
  node.type === 'enhanced_for_statement'
