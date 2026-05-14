/**
 * @fileoverview Lightweight Java "parse" — returns content metadata.
 *
 * The MVP Java adapter does not ship a full AST parser. Tree-sitter
 * integration is deferred (see docs/plans/multi-language-support).
 * `parse()` returns a minimal tree object that exposes the source text
 * and line offsets, enough for text-pattern checks.
 *
 * Future: replace with web-tree-sitter + tree-sitter-java to produce a
 * real AST. The adapter contract is unchanged — only the TTree shape
 * grows.
 */

export interface JavaTree {
  readonly source: string
  readonly filePath: string
  readonly lineStarts: readonly number[]
}

function buildLineStarts(src: string): number[] {
  const out = [0]
  // Index loop: we need the UTF-16 code unit offset (i + 1) for line starts.
  // [...src] would split by code points and break offsets for surrogate pairs.
  // eslint-disable-next-line unicorn/no-for-loop -- offset-bearing scan, not pure iteration
  for (let i = 0; i < src.length; i++) {
    if (src[i] === '\n') out.push(i + 1)
  }
  return out
}

export function parseJava(content: string, filePath: string): JavaTree | null {
  return {
    source: content,
    filePath,
    lineStarts: buildLineStarts(content),
  }
}
