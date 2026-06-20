/**
 * @fileoverview Rust parse — web-tree-sitter + vendored tree-sitter-rust.wasm.
 *
 * ADR-0010: `lang-rust` is the canonical Rust parse substrate — fitness checks
 * parse via the adapter (`getSharedTree`) and the graph Rust adapter consumes
 * this too. The grammar loads once at module top level (the WASM runtime is
 * initialized by `@opensip-cli/tree-sitter`'s top-level `Parser.init()`); a
 * single reused parser keeps `parse()` synchronous. Tree-sitter recovers from
 * syntax errors with MISSING nodes, so a malformed file yields a partial tree
 * (non-null) rather than throwing.
 */

import { fileURLToPath } from 'node:url';

import { logger } from '@opensip-cli/core';
import { loadGrammar, createParser, parseToTree, type ParsedFile } from '@opensip-cli/tree-sitter';

// Load the grammar once at module top level (keeps parse() synchronous). A
// missing/corrupt/ABI-mismatched .wasm must NOT crash the whole CLI — contain
// the failure so Rust analysis degrades to "unavailable" (parse returns null).
let parser: ReturnType<typeof createParser> | undefined;
/* v8 ignore start -- grammar-load failure is environment-dependent (bad/missing .wasm); not reproducible under the test runner */
try {
  const grammar = await loadGrammar(
    fileURLToPath(new URL('../wasm/tree-sitter-rust.wasm', import.meta.url)),
  );
  parser = createParser(grammar);
} catch (error) {
  logger.warn({
    evt: 'lang.grammar.load_failed',
    module: 'lang:rust',
    msg: `Rust grammar failed to load — Rust analysis is unavailable this run: ${error instanceof Error ? error.message : String(error)}`,
  });
}
/* v8 ignore stop */

/** Parsed Rust source: tree-sitter parse tree plus the original source text. */
export type RustTree = ParsedFile;

/** Parses Rust source into a {@link RustTree}, or null when no tree is produced. */
export function parseRust(content: string, _filePath: string): RustTree | null {
  /* v8 ignore next -- defensive: parser is undefined only when the grammar failed to load */
  if (!parser) return null;
  const tree = parseToTree(parser, content);
  return tree ? { tree, source: content } : null;
}
