/**
 * @fileoverview Python parse — web-tree-sitter + vendored tree-sitter-python.wasm.
 *
 * ADR-0010: `lang-python` is the canonical Python parse substrate for the whole
 * platform — fitness checks parse via the adapter (`getSharedTree`) and the
 * graph Python adapter consumes this too. The grammar is loaded once at module
 * top level (the WASM runtime is initialized by `@opensip-cli/tree-sitter`'s
 * own top-level `Parser.init()`, statically imported here); a single reused
 * parser keeps `parse()` synchronous and allocation-free. Tree-sitter recovers
 * from syntax errors with MISSING nodes, so a malformed file yields a partial
 * tree (non-null) rather than throwing — callers can inspect `rootNode.hasError`.
 */

import { fileURLToPath } from 'node:url';

import { logger } from '@opensip-cli/core';
import { loadGrammar, createParser, parseToTree, type ParsedFile } from '@opensip-cli/tree-sitter';

// Load the grammar once at module top level (keeps parse() synchronous). A
// missing/corrupt/ABI-mismatched .wasm must NOT crash the whole CLI — contain
// the failure so Python analysis degrades to "unavailable" (parse returns null).
let parser: ReturnType<typeof createParser> | undefined;
/* v8 ignore start -- grammar-load failure is environment-dependent (bad/missing .wasm); not reproducible under the test runner */
try {
  const grammar = await loadGrammar(
    fileURLToPath(new URL('../wasm/tree-sitter-python.wasm', import.meta.url)),
  );
  parser = createParser(grammar);
} catch (error) {
  logger.warn({
    evt: 'lang.grammar.load_failed',
    module: 'lang:python',
    msg: `Python grammar failed to load — Python analysis is unavailable this run: ${error instanceof Error ? error.message : String(error)}`,
  });
}
/* v8 ignore stop */

/** Parsed Python source: tree-sitter parse tree plus the original source text. */
export type PythonTree = ParsedFile;

/** Parses Python source into a {@link PythonTree}, or null when no tree is produced. */
export function parsePython(content: string, _filePath: string): PythonTree | null {
  /* v8 ignore next -- defensive: parser is undefined only when the grammar failed to load */
  if (!parser) return null;
  const tree = parseToTree(parser, content);
  return tree ? { tree, source: content } : null;
}
