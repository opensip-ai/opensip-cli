// @fitness-ignore-file duplicate-utility-functions -- ADR-0010: the per-language tree-sitter vocabulary intentionally shares helper names across lang-* with grammar-specific implementations; consolidating would defeat the substrate design.
/**
 * Composed enclosing-scope helpers for Rust (ADR-0010) — the per-language layer
 * over the generic `findEnclosing`/`nameOf` from `@opensip-cli/tree-sitter`.
 */

import { findEnclosing, nameOf, type Node } from '@opensip-cli/tree-sitter';

import { isFunction, isImpl } from './predicates.js';

/** The nearest enclosing `fn` of `node`, or `null` at module scope. */
export function findEnclosingFunction(node: Node): Node | null {
  return findEnclosing(node, isFunction);
}

/** The name of the nearest enclosing `fn`, or `null`. */
export function getEnclosingFunctionName(node: Node): string | null {
  const fn = findEnclosingFunction(node);
  return fn ? nameOf(fn) : null;
}

/**
 * True when `node` is a method — a `fn` item whose nearest enclosing
 * function-or-impl is an `impl` block. A free function (or a `fn` nested in
 * another `fn`) is therefore not a method.
 */
export function isMethod(node: Node): boolean {
  if (!isFunction(node)) return false;
  const enclosing = findEnclosing(node, (n) => isFunction(n) || isImpl(n));
  return enclosing !== null && isImpl(enclosing);
}
