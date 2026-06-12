/**
 * @fileoverview Java parse — web-tree-sitter + vendored tree-sitter-java.wasm.
 *
 * ADR-0010: `lang-java` is the canonical Java parse substrate — fitness checks
 * parse via the adapter (`getSharedTree`) and the graph Java adapter consumes
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
  fileURLToPath(new URL('../wasm/tree-sitter-java.wasm', import.meta.url)),
);
const parser = createParser(grammar);

/** Parsed Java source: tree-sitter parse tree plus the original source text. */
export type JavaTree = ParsedFile;

/** Parses Java source into a {@link JavaTree}, or null when no tree is produced. */
export function parseJava(content: string, _filePath: string): JavaTree | null {
  const tree = parseToTree(parser, content);
  return tree ? { tree, source: content } : null;
}
