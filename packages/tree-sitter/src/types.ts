/**
 * Neutral tree-sitter types — the grammar-agnostic surface both `lang-*`
 * adapters and the graph adapters consume. Deliberately free of any
 * `@opensip-tools/graph` coupling (the reason this package exists, ADR-0010).
 */

import type { Tree } from 'web-tree-sitter';

export type { Node, Tree, Language } from 'web-tree-sitter';

/**
 * The parsed-file shape every tree-sitter consumer uses: the parse tree
 * plus the original source text (held so body slices can be extracted for
 * hashing without re-parsing). Matches the graph adapters' historical
 * `{ tree, source }` record exactly.
 */
export interface ParsedFile {
  readonly tree: Tree;
  readonly source: string;
}
