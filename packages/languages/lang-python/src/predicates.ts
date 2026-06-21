// @fitness-ignore-file duplicate-utility-functions -- ADR-0010: the per-language tree-sitter vocabulary intentionally shares helper names across lang-* with grammar-specific implementations; consolidating would defeat the substrate design.
/**
 * v1 per-language node-kind predicates for Python (ADR-0010). The generic
 * traversal/position helpers live in `@opensip-cli/tree-sitter`; only the
 * grammar-specific node `type` strings differ per language, and they live here.
 * Node types are from the tree-sitter-python grammar.
 */

import { findEnclosing, type Node } from '@opensip-cli/tree-sitter';

/** A `def` — both top-level functions and methods are `function_definition`. */
export const isFunction = (node: Node): boolean => node.type === 'function_definition';

/** A `class` declaration. */
export const isClass = (node: Node): boolean => node.type === 'class_definition';

/** A `#` comment. */
export const isComment = (node: Node): boolean => node.type === 'comment';

/** A string literal (also covers f-strings / docstrings at the node level). */
export const isString = (node: Node): boolean => node.type === 'string';

/** An `except[ … ]:` clause — Python's error-handling node. */
export const isExcept = (node: Node): boolean => node.type === 'except_clause';

/** An `if` statement. */
export const isConditional = (node: Node): boolean => node.type === 'if_statement';

/** A `for` or `while` loop. */
export const isLoop = (node: Node): boolean =>
  node.type === 'for_statement' || node.type === 'while_statement';

/**
 * True when `node` is a method — a `function_definition` whose *nearest*
 * enclosing function-or-class is a class. A function nested inside another
 * function is therefore not a method (its nearest enclosing scope is a `def`).
 * Normalized into predicates.ts (M10): `isMethod` lives in predicates.ts in
 * every tree-sitter adapter.
 */
export const isMethod = (node: Node): boolean => {
  if (!isFunction(node)) return false;
  const enclosing = findEnclosing(node, (n) => isFunction(n) || isClass(n));
  return enclosing !== null && isClass(enclosing);
};
