/**
 * @fileoverview Lightweight Go "parse" — returns content metadata.
 *
 * The MVP Go adapter does not ship a full AST parser. Tree-sitter
 * integration is deferred. `parse()` returns a minimal tree object
 * that exposes the source text and line offsets, enough for
 * text-pattern checks. Delegates to core's shared
 * `buildMinimalTextTree` factory; the `GoTree` alias keeps the
 * adapter generic-parameter name distinct so future per-language
 * tree-sitter trees can grow independently.
 *
 * Future: replace with web-tree-sitter + tree-sitter-go to produce a
 * real AST. The adapter contract is unchanged — only the GoTree shape
 * grows.
 */

import { buildMinimalTextTree, type MinimalTextTree } from '@opensip-tools/core'

/** Parse-tree alias for Go (currently a minimal text tree; will become a real AST). */
export type GoTree = MinimalTextTree

/** Parses Go source into a {@link GoTree} for check consumption. */
export function parseGo(content: string, filePath: string): GoTree {
  return buildMinimalTextTree(content, filePath)
}
