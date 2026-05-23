/**
 * @fileoverview Minimal text-tree shape shared by MVP language adapters.
 *
 * Several first-party language adapters (lang-go, lang-java, lang-rust,
 * lang-python) ship without a real AST parser today — tree-sitter
 * integration is deferred. Their `parse()` implementations all return
 * the same triple: source text + file path + a precomputed line-starts
 * index. The triple is the minimum surface text-pattern checks need to
 * report (line, column) coordinates.
 *
 * `MinimalTextTree` is the shared shape; `buildMinimalTextTree(content,
 * filePath)` is the factory each MVP adapter delegates to. Each pack
 * still keeps its own typed `XTree` interface (e.g. `GoTree`, `JavaTree`,
 * `RustTree`) so adapter generic parameters stay distinct — those are
 * thin brand aliases over `MinimalTextTree`.
 *
 * When a pack grows a real tree-sitter parser, it replaces its `parse()`
 * body and the typed `XTree` shape; the brand alias bridges the
 * transition.
 */

import { buildLineStarts } from './strip-utils.js';

/**
 * Minimum source-tree shape every text-pattern check expects. Adapters
 * branding their own typed alias over this can grow it later.
 */
export interface MinimalTextTree {
  /** The original source text the tree was built from. */
  readonly source: string;
  /** The file path that produced the source — used in diagnostics. */
  readonly filePath: string;
  /**
   * Precomputed line-start byte offsets. `lineStarts[0] === 0`, and
   * `lineStarts[i]` is the offset of the character immediately after
   * the `i`th newline. Used to translate byte offsets into (line,
   * column) coordinates in `O(log n)` per lookup.
   */
  readonly lineStarts: readonly number[];
}

/**
 * Build a `MinimalTextTree` for a source string. Used by MVP language
 * adapters whose `parse()` returns the source text and a line index
 * rather than a full AST.
 */
export function buildMinimalTextTree(content: string, filePath: string): MinimalTextTree {
  return {
    source: content,
    filePath,
    lineStarts: buildLineStarts(content),
  };
}
