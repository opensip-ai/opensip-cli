/**
 * @fileoverview Rust parse — web-tree-sitter + vendored tree-sitter-rust.wasm.
 *
 * ADR-0010: `lang-rust` is the canonical Rust parse substrate — fitness checks
 * parse via the adapter (`getSharedTree`) and the graph Rust adapter consumes
 * this too. The grammar loads once at module top level (the WASM runtime is
 * initialized by `@opensip-tools/tree-sitter`'s top-level `Parser.init()`); a
 * single reused parser keeps `parse()` synchronous. Tree-sitter recovers from
 * syntax errors with MISSING nodes, so a malformed file yields a partial tree
 * (non-null) rather than throwing.
 */

import { fileURLToPath } from 'node:url'

import { loadGrammar, createParser, parseToTree, type ParsedFile } from '@opensip-tools/tree-sitter'

const grammar = await loadGrammar(
  fileURLToPath(new URL('../wasm/tree-sitter-rust.wasm', import.meta.url)),
)
const parser = createParser(grammar)

/** Parsed Rust source: tree-sitter parse tree plus the original source text. */
export type RustTree = ParsedFile

/** Parses Rust source into a {@link RustTree}, or null when no tree is produced. */
export function parseRust(content: string, _filePath: string): RustTree | null {
  const tree = parseToTree(parser, content)
  return tree ? { tree, source: content } : null
}
