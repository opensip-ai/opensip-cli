// @fitness-ignore-file unbounded-memory -- reads source files one at a time; per-file memory bounded by source size (tree-sitter constraint)
/**
 * Shared tree-sitter `parseProject` scaffolding.
 *
 * The four tree-sitter adapters' `parseProject` bodies are byte-identical
 * save the grammar binding, the `setLanguage` cast, the `graph:parse:<id>`
 * log tag, and the named `*ParsedFile` / `*ParsedProject` types. Per
 * contract invariant I-7, `parseProject` is total over `input.files`:
 * every file either parses or surfaces in `parseErrors`. Tree-sitter
 * recovers from syntax errors with MISSING nodes; we surface a ParseError
 * when the root `hasError` but keep the partial tree for the walk.
 *
 * `createTreeSitterParseProject` closes over the grammar + languageId and
 * a `makeFile(tree, source)` factory (trivially `{ tree, source }` for all
 * four today) and returns a `parseProject` that produces a project whose
 * `files` map is keyed by absolute file path. Adapters re-export their own
 * nominal `*ParsedProject` type for resolvers/tests (DEC-2).
 */

import { readFileSync } from 'node:fs';
import { relative } from 'node:path';

import { logger } from '@opensip-tools/core';
import Parser from 'tree-sitter';

import type { ParseInput, ParseOutput, ParseError } from '@opensip-tools/graph';

/**
 * The parsed-file shape every tree-sitter adapter uses: the parse tree
 * plus the original source text (held so body slices can be extracted
 * for hashing without re-parsing).
 */
export interface TreeSitterParsedFile {
  readonly tree: Parser.Tree;
  readonly source: string;
}

/** A parsed tree-sitter project: map of absolute file path → parsed file. */
export interface TreeSitterParsedProject<F extends TreeSitterParsedFile = TreeSitterParsedFile> {
  readonly files: ReadonlyMap<string, F>;
}

/** Per-language inputs to the shared parse template. */
export interface TreeSitterParseConfig<F extends TreeSitterParsedFile = TreeSitterParsedFile> {
  /**
   * The tree-sitter grammar module (`tree-sitter-go` etc.). Typed as
   * `unknown` because each grammar's CJS `Language` type does not unify
   * with tree-sitter's `Language` under `--strict`; the cast is applied
   * once here.
   */
  readonly grammar: unknown;
  /** Log-tag suffix for `graph:parse:<languageId>`. */
  readonly languageId: string;
  /** Builds the per-file record. Defaults to `{ tree, source }`. */
  readonly makeFile?: (tree: Parser.Tree, source: string) => F;
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
    parser.setLanguage(grammar as Parser.Language);

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
      let tree: Parser.Tree;
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
