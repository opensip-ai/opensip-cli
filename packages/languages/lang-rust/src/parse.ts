/**
 * @fileoverview Lightweight Rust "parse" — returns content metadata.
 *
 * The MVP Rust adapter does not ship a full AST parser. Tree-sitter
 * integration is deferred. `parse()` returns a minimal tree object
 * that exposes the source text and line offsets, enough for
 * text-pattern checks. Delegates to core's shared
 * `buildMinimalTextTree` factory; the `RustTree` alias keeps the
 * adapter generic-parameter name distinct so future per-language
 * tree-sitter trees can grow independently.
 *
 * Future: replace with web-tree-sitter + tree-sitter-rust to produce a
 * real AST. The adapter contract is unchanged — only the RustTree
 * shape grows.
 */

import { buildMinimalTextTree, type MinimalTextTree } from '@opensip-tools/core'

export type RustTree = MinimalTextTree

export function parseRust(content: string, filePath: string): RustTree | null {
  return buildMinimalTextTree(content, filePath)
}
