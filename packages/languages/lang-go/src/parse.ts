/**
 * @fileoverview Go parse — web-tree-sitter + vendored tree-sitter-go.wasm.
 *
 * ADR-0010: `lang-go` is the canonical Go parse substrate — fitness checks
 * parse via the adapter (`getSharedTree`) and the graph Go adapter consumes
 * this too. The grammar loads once at module top level (the WASM runtime is
 * initialized by `@opensip-cli/tree-sitter`'s top-level `Parser.init()`); a
 * single reused parser keeps `parse()` synchronous. Tree-sitter recovers from
 * syntax errors with MISSING nodes, so a malformed file yields a partial tree
 * (non-null) rather than throwing.
 */

import { fileURLToPath } from 'node:url';

import {
  loadGrammar,
  createParser,
  parseToTree,
  type ParsedFile,
} from '@opensip-cli/tree-sitter';

const grammar = await loadGrammar(
  fileURLToPath(new URL('../wasm/tree-sitter-go.wasm', import.meta.url)),
);
const parser = createParser(grammar);

/** Parsed Go source: tree-sitter parse tree plus the original source text. */
export type GoTree = ParsedFile;

/** Parses Go source into a {@link GoTree}, or null when no tree is produced. */
export function parseGo(content: string, _filePath: string): GoTree | null {
  const tree = parseToTree(parser, content);
  return tree ? { tree, source: content } : null;
}
