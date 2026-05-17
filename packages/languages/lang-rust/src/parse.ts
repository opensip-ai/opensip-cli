/**
 * @fileoverview Lightweight Rust "parse" — returns content metadata.
 *
 * The MVP Rust adapter does not ship a full AST parser. Tree-sitter
 * integration is deferred. `parse()` returns a minimal tree object
 * that exposes the source text and line offsets, enough for
 * text-pattern checks.
 *
 * Future: replace with web-tree-sitter + tree-sitter-rust to produce a
 * real AST. The adapter contract is unchanged — only the TTree shape
 * grows.
 */

import { buildLineStarts } from '@opensip-tools/core'

export interface RustTree {
  readonly source: string
  readonly filePath: string
  readonly lineStarts: readonly number[]
}

export function parseRust(content: string, filePath: string): RustTree | null {
  return {
    source: content,
    filePath,
    lineStarts: buildLineStarts(content),
  }
}
