/**
 * Parsed-project type surface for the tree-sitter graph adapters.
 *
 * ADR-0010 (rollout complete): all four tree-sitter adapters (python, rust, go,
 * java) now parse via their `@opensip-cli/lang-*` package through
 * `createParseProjectFromAdapter` (see ./parse-from-adapter.ts). The former
 * grammar-bound `createTreeSitterParseProject` driver — and its `Parser.init()`
 * seam — have been removed; this module is reduced to the two nominal types the
 * adapters and the walk/resolve scaffolding still share. The parsed-file shape
 * is sourced from the canonical substrate so graph-adapter-common no longer
 * depends on `web-tree-sitter`.
 */

import type { ParsedFile } from '@opensip-cli/tree-sitter';

/**
 * The parsed-file shape every tree-sitter adapter uses: the parse tree plus the
 * original source text (held so body slices can be extracted for hashing
 * without re-parsing). Identical to the substrate's `ParsedFile`.
 */
export type TreeSitterParsedFile = ParsedFile;

/** A parsed tree-sitter project: map of absolute file path → parsed file. */
export interface TreeSitterParsedProject<F extends TreeSitterParsedFile = TreeSitterParsedFile> {
  readonly files: ReadonlyMap<string, F>;
}
