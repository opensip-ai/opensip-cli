/**
 * @fileoverview Lightweight Java "parse" — returns content metadata.
 *
 * The MVP Java adapter does not ship a full AST parser. Tree-sitter
 * integration is deferred. `parse()` returns a minimal tree object
 * that exposes the source text and line offsets, enough for
 * text-pattern checks. Delegates to core's shared
 * `buildMinimalTextTree` factory; the `JavaTree` alias keeps the
 * adapter generic-parameter name distinct so future per-language
 * tree-sitter trees can grow independently.
 *
 * Future: replace with web-tree-sitter + tree-sitter-java to produce a
 * real AST. The adapter contract is unchanged — only the JavaTree
 * shape grows.
 */

import { buildMinimalTextTree, type MinimalTextTree } from '@opensip-tools/core'

/** Parse-tree alias for Java (currently a minimal text tree; will become a real AST). */
export type JavaTree = MinimalTextTree

/** Parses Java source into a {@link JavaTree} for check consumption. */
export function parseJava(content: string, filePath: string): JavaTree {
  return buildMinimalTextTree(content, filePath)
}
