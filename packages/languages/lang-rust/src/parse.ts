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

/** Parse-tree alias for Rust (currently a minimal text tree; will become a real AST). */
export type RustTree = MinimalTextTree

/**
 * Build the Rust adapter's text-tree shim. The current MVP body
 * delegates to `buildMinimalTextTree`, which never returns `null`; the
 * empty-`filePath` case is accepted as a pass-through (the tree still
 * carries `filePath: ''` for diagnostics; callers that want to reject
 * empty paths should validate upstream). When tree-sitter integration
 * lands, the return type will widen to `RustTree | null` and parse
 * failures will become reachable; downstream consumers should then
 * gate on the result.
 */
export function parseRust(content: string, filePath: string): RustTree {
  return buildMinimalTextTree(content, filePath)
}
