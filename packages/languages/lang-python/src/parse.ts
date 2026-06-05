/**
 * @fileoverview Python parse — web-tree-sitter + vendored tree-sitter-python.wasm.
 *
 * ADR-0010: `lang-python` is the canonical Python parse substrate for the whole
 * platform — fitness checks parse via the adapter (`getSharedTree`) and the
 * graph Python adapter consumes this too. The grammar is loaded once at module
 * top level (the WASM runtime is initialized by `@opensip-tools/tree-sitter`'s
 * own top-level `Parser.init()`, statically imported here); a single reused
 * parser keeps `parse()` synchronous and allocation-free. Tree-sitter recovers
 * from syntax errors with MISSING nodes, so a malformed file yields a partial
 * tree (non-null) rather than throwing — callers can inspect `rootNode.hasError`.
 */

import { fileURLToPath } from 'node:url'

import { loadGrammar, createParser, parseToTree, type ParsedFile } from '@opensip-tools/tree-sitter'

const grammar = await loadGrammar(
  fileURLToPath(new URL('../wasm/tree-sitter-python.wasm', import.meta.url)),
)
const parser = createParser(grammar)

/** Parsed Python source: tree-sitter parse tree plus the original source text. */
export type PythonTree = ParsedFile

/** Parses Python source into a {@link PythonTree}, or null when no tree is produced. */
export function parsePython(content: string, _filePath: string): PythonTree | null {
  const tree = parseToTree(parser, content)
  return tree ? { tree, source: content } : null
}
