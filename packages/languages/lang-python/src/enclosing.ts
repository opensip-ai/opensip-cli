// @fitness-ignore-file duplicate-utility-functions -- ADR-0010: the per-language tree-sitter vocabulary intentionally shares helper names across lang-* with grammar-specific implementations; consolidating would defeat the substrate design.
/**
 * Composed enclosing-scope helpers for Python (ADR-0010) — the per-language
 * layer over the generic `findEnclosing`/`nameOf` from
 * `@opensip-cli/tree-sitter`. Mirrors `lang-typescript`'s
 * `findEnclosingFunction` / `getEnclosingFunctionName`. `isMethod` lives in
 * predicates.ts (normalized in M10), alongside the other node-kind predicates.
 */

import { findEnclosing, nameOf, type Node } from '@opensip-cli/tree-sitter';

import { isFunction } from './predicates.js';

/** The nearest enclosing `def` of `node`, or `null` at module scope. */
export function findEnclosingFunction(node: Node): Node | null {
  return findEnclosing(node, isFunction);
}

/** The name of the nearest enclosing `def`, or `null`. */
export function getEnclosingFunctionName(node: Node): string | null {
  const fn = findEnclosingFunction(node);
  return fn ? nameOf(fn) : null;
}
