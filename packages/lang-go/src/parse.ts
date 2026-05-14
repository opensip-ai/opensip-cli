/**
 * @fileoverview Lightweight Go "parse" — returns content metadata.
 *
 * The MVP Go adapter does not ship a full AST parser. Tree-sitter
 * integration is deferred (see docs/plans/multi-language-support).
 * `parse()` returns a minimal tree object that exposes the source text
 * and line offsets, enough for text-pattern checks.
 *
 * Future: replace with web-tree-sitter + tree-sitter-go to produce a
 * real AST. The adapter contract is unchanged — only the TTree shape
 * grows.
 */

export interface GoTree {
  readonly source: string
  readonly filePath: string
  readonly lineStarts: readonly number[]
}

function buildLineStarts(src: string): number[] {
  const out = [0]
  for (let i = 0; i < src.length; i++) {
    if (src[i] === '\n') out.push(i + 1)
  }
  return out
}

export function parseGo(content: string, filePath: string): GoTree | null {
  return {
    source: content,
    filePath,
    lineStarts: buildLineStarts(content),
  }
}
