/**
 * @fileoverview Lightweight Python "parse" — returns content metadata.
 *
 * The MVP Python adapter does not ship a full AST parser. Tree-sitter
 * integration is deferred. `parse()` returns a minimal tree object
 * that exposes the source text and line offsets, enough for
 * text-pattern checks. Delegates to core's shared
 * `buildMinimalTextTree` factory; the `PythonTree` alias keeps the
 * adapter generic-parameter name distinct so future per-language
 * tree-sitter trees can grow independently.
 *
 * Future: replace with web-tree-sitter + tree-sitter-python to produce
 * a real AST. The adapter contract is unchanged — only the PythonTree
 * shape grows.
 */

import { buildMinimalTextTree, type MinimalTextTree } from '@opensip-tools/core'

/** Parse-tree alias for Python (currently a minimal text tree; will become a real AST). */
export type PythonTree = MinimalTextTree

/** Parses Python source into a {@link PythonTree}, or null on unparseable input. */
export function parsePython(content: string, filePath: string): PythonTree | null {
  return buildMinimalTextTree(content, filePath)
}
