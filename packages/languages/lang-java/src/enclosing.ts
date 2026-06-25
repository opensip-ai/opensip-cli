/**
 * Composed enclosing-scope helpers for Java (ADR-0010) — the per-language layer
 * over the generic `findEnclosing`/`nameOf` from `@opensip-cli/tree-sitter`.
 * `isMethod` is grammar-direct (Java's `method_declaration`) and lives in
 * predicates.ts; this module composes the enclosing-function lookups.
 */

import { findEnclosing, nameOf, type Node } from '@opensip-cli/tree-sitter';

import { isFunction } from './predicates.js';

/** The nearest enclosing method/constructor of `node`, or `null` at class scope. */
// @yagni-ignore-next-line duplicate-body-candidate -- per-language adapter helper intentionally mirrors tree-sitter composition while keeping language packages independent.
export function findEnclosingFunction(node: Node): Node | null {
  return findEnclosing(node, isFunction);
}

/** The name of the nearest enclosing method/constructor, or `null`. */
// @yagni-ignore-next-line duplicate-body-candidate -- per-language adapter helper intentionally mirrors tree-sitter composition while keeping language packages independent.
export function getEnclosingFunctionName(node: Node): string | null {
  const fn = findEnclosingFunction(node);
  return fn ? nameOf(fn) : null;
}
