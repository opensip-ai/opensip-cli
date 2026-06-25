/**
 * Composed enclosing-scope helpers for Rust (ADR-0010) — the per-language layer
 * over the generic `findEnclosing`/`nameOf` from `@opensip-cli/tree-sitter`.
 * `isMethod` lives in predicates.ts (normalized in M10), alongside the other
 * node-kind predicates, in every tree-sitter adapter.
 */

import { findEnclosing, nameOf, type Node } from '@opensip-cli/tree-sitter';

import { isFunction } from './predicates.js';

/** The nearest enclosing `fn` of `node`, or `null` at module scope. */
// @yagni-ignore-next-line duplicate-body-candidate -- per-language adapter helper intentionally mirrors tree-sitter composition while keeping language packages independent.
export function findEnclosingFunction(node: Node): Node | null {
  return findEnclosing(node, isFunction);
}

/** The name of the nearest enclosing `fn`, or `null`. */
// @yagni-ignore-next-line duplicate-body-candidate -- per-language adapter helper intentionally mirrors tree-sitter composition while keeping language packages independent.
export function getEnclosingFunctionName(node: Node): string | null {
  const fn = findEnclosingFunction(node);
  return fn ? nameOf(fn) : null;
}
