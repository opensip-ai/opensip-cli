// @fitness-ignore-file duplicate-utility-functions -- ADR-0010: the per-language tree-sitter vocabulary intentionally shares helper names across lang-* with grammar-specific implementations; consolidating would defeat the substrate design.
/**
 * Composed enclosing-scope helpers for Go (ADR-0010) — the per-language layer
 * over the generic `findEnclosing`/`nameOf` from `@opensip-tools/tree-sitter`.
 * `isMethod` is grammar-direct (Go's `method_declaration`), so it lives in
 * predicates.ts; this module composes the enclosing-function lookups.
 */

import { findEnclosing, nameOf, type Node } from '@opensip-tools/tree-sitter'

import { isFunction } from './predicates.js'

/** The nearest enclosing func/method of `node`, or `null` at file scope. */
export function findEnclosingFunction(node: Node): Node | null {
  return findEnclosing(node, isFunction)
}

/** The name of the nearest enclosing func/method, or `null`. */
export function getEnclosingFunctionName(node: Node): string | null {
  const fn = findEnclosingFunction(node)
  return fn ? nameOf(fn) : null
}
