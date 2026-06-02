// @fitness-ignore-file unbounded-memory -- reads source files one at a time; per-file memory bounded by source size (tree-sitter constraint)
/**
 * Shared tree-sitter `parseProject` scaffolding (web-tree-sitter / WASM).
 *
 * The four tree-sitter adapters' `parseProject` bodies are byte-identical
 * save the grammar `Language`, the `graph:parse:<id>` log tag, and the
 * named `*ParsedFile` / `*ParsedProject` types. Per contract invariant
 * I-7, `parseProject` is total over `input.files`: every file either
 * parses or surfaces in `parseErrors`. Tree-sitter recovers from syntax
 * errors with MISSING nodes; we surface a ParseError when the root
 * `hasError` but keep the partial tree for the walk.
 *
 * ## Sync `parseProject` over an async runtime (the load-bearing seam)
 *
 * `web-tree-sitter` needs a one-time async init (`Parser.init()`) and a
 * one-time async grammar load (`Language.load(<wasm>)`), but
 * `parser.parse(source)` is **synchronous** once a language is loaded.
 * The `GraphLanguageAdapter.parseProject` contract is synchronous and must
 * stay so (the engine calls it synchronously; the shard worker serializes
 * results across a process boundary).
 *
 * We confine the async to module top-level `await`:
 *   - `await Parser.init()` runs here, in this module, which every adapter
 *     statically imports — so the WASM runtime is initialized before any
 *     adapter's own top-level `Language.load()` runs.
 *   - each adapter does `await Language.load(<wasm>)` at *its* module top
 *     level and passes the resolved `Language` in as `config.grammar`.
 * Adapter discovery `import()`s the adapter package (async), so both
 * top-level awaits settle before the engine ever calls `parseProject`.
 * Zero change to the `GraphLanguageAdapter` contract.
 *
 * `createTreeSitterParseProject` closes over the loaded `Language` +
 * languageId and a `makeFile(tree, source)` factory (trivially
 * `{ tree, source }` for all four today) and returns a `parseProject`
 * that produces a project whose `files` map is keyed by absolute file
 * path. Adapters re-export their own nominal `*ParsedProject` type for
 * resolvers/tests (DEC-2).
 */

import { readFileSync } from 'node:fs';
import { relative } from 'node:path';

import { logger } from '@opensip-tools/core';
import { Parser, type Language, type Tree } from 'web-tree-sitter';

import type { ParseInput, ParseOutput, ParseError } from '@opensip-tools/graph';

// One-time WASM runtime init. Top-level await in this module — statically
// imported by every adapter — guarantees the runtime is ready before any
// adapter's `Language.load(<wasm>)` (which also runs at module top level).
await Parser.init();

/**
 * The parsed-file shape every tree-sitter adapter uses: the parse tree
 * plus the original source text (held so body slices can be extracted
 * for hashing without re-parsing).
 */
export interface TreeSitterParsedFile {
  readonly tree: Tree;
  readonly source: string;
}

/** A parsed tree-sitter project: map of absolute file path → parsed file. */
export interface TreeSitterParsedProject<F extends TreeSitterParsedFile = TreeSitterParsedFile> {
  readonly files: ReadonlyMap<string, F>;
}

/** Per-language inputs to the shared parse template. */
export interface TreeSitterParseConfig<F extends TreeSitterParsedFile = TreeSitterParsedFile> {
  /**
   * The loaded web-tree-sitter `Language` for this adapter — the result of
   * the adapter's top-level `await Language.load(<wasm>)`.
   */
  readonly grammar: Language;
  /** Log-tag suffix for `graph:parse:<languageId>`. */
  readonly languageId: string;
  /** Builds the per-file record. Defaults to `{ tree, source }`. */
  readonly makeFile?: (tree: Tree, source: string) => F;
}

/** Builds the adapter's `parseProject` from per-language config. */
export function createTreeSitterParseProject<F extends TreeSitterParsedFile = TreeSitterParsedFile>(
  config: TreeSitterParseConfig<F>,
): (input: ParseInput) => ParseOutput<TreeSitterParsedProject<F>> {
  const { grammar, languageId } = config;
  const makeFile = config.makeFile ?? ((tree, source) => ({ tree, source } as F));
  const module = `graph:parse:${languageId}`;

  return function parseProject(input: ParseInput): ParseOutput<TreeSitterParsedProject<F>> {
    const parser = new Parser();
    parser.setLanguage(grammar);

    const files = new Map<string, F>();
    const parseErrors: ParseError[] = [];

    for (const path of input.files) {
      let source: string;
      /* v8 ignore start */
      try {
        source = readFileSync(path, 'utf8');
      } catch (error) {
        parseErrors.push({
          filePath: relative(input.projectDirAbs, path),
          message: `read failed: ${error instanceof Error ? error.message : String(error)}`,
        });
        continue;
      }
      /* v8 ignore stop */
      let tree: Tree | null;
      /* v8 ignore start */
      try {
        tree = parser.parse(source);
      } catch (error) {
        parseErrors.push({
          filePath: relative(input.projectDirAbs, path),
          message: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      /* v8 ignore stop */
      // web-tree-sitter's `parse` returns `Tree | null` (null only when no
      // language is set or a progress callback aborts — neither applies
      // here). Guard defensively to keep `parseProject` total (I-7).
      /* v8 ignore start */
      if (tree === null) {
        parseErrors.push({
          filePath: relative(input.projectDirAbs, path),
          message: 'tree-sitter returned no tree',
        });
        continue;
      }
      /* v8 ignore stop */
      if (tree.rootNode.hasError) {
        parseErrors.push({
          filePath: relative(input.projectDirAbs, path),
          message: 'tree-sitter reported syntax errors; partial tree retained',
        });
      }
      files.set(path, makeFile(tree, source));
    }

    logger.info({
      evt: 'graph.parse.complete',
      module,
      files: files.size,
      parseErrors: parseErrors.length,
    });

    return { project: { files }, parseErrors };
  };
}
