/**
 * @fileoverview Lightweight Java "parse" — returns content metadata.
 *
 * The MVP Java adapter does not ship a full AST parser. Tree-sitter
 * integration is deferred.
 * `parse()` returns a minimal tree object that exposes the source text
 * and line offsets, enough for text-pattern checks.
 *
 * Future: replace with web-tree-sitter + tree-sitter-java to produce a
 * real AST. The adapter contract is unchanged — only the TTree shape
 * grows.
 */

import { buildLineStarts } from '@opensip-tools/core'

export interface JavaTree {
  readonly source: string
  readonly filePath: string
  readonly lineStarts: readonly number[]
}

export function parseJava(content: string, filePath: string): JavaTree | null {
  return {
    source: content,
    filePath,
    lineStarts: buildLineStarts(content),
  }
}
