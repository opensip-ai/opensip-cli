// @fitness-ignore-file duplicate-utility-functions -- ADR-0010: the per-language tree-sitter vocabulary intentionally shares helper names across lang-* with grammar-specific implementations; consolidating would defeat the substrate design.
/**
 * Composed enclosing-scope helpers for Python (ADR-0010) — the per-language
 * layer over the generic `findEnclosing`/`nameOf` from
 * `@opensip-tools/tree-sitter`. Mirrors `lang-typescript`'s
 * `findEnclosingFunction` / `getEnclosingFunctionName`.
 */

import { findEnclosing, nameOf, type Node } from '@opensip-tools/tree-sitter'

import { isClass, isFunction } from './predicates.js'

/** The nearest enclosing `def` of `node`, or `null` at module scope. */
export function findEnclosingFunction(node: Node): Node | null {
  return findEnclosing(node, isFunction)
}

/** The name of the nearest enclosing `def`, or `null`. */
export function getEnclosingFunctionName(node: Node): string | null {
  const fn = findEnclosingFunction(node)
  return fn ? nameOf(fn) : null
}

/**
 * True when `node` is a method — a `function_definition` whose *nearest*
 * enclosing function-or-class is a class. A function nested inside another
 * function is therefore not a method (its nearest enclosing scope is a `def`).
 */
export function isMethod(node: Node): boolean {
  if (!isFunction(node)) return false
  const enclosing = findEnclosing(node, (n) => isFunction(n) || isClass(n))
  return enclosing !== null && isClass(enclosing)
}
