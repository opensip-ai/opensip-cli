// @fitness-ignore-file unbounded-memory -- reads source files one at a time; per-file memory bounded by source size (tree-sitter constraint)
/**
 * Go parseProject — tree-sitter-go.
 *
 * Per contract invariant I-7 (parseProject is total over `files`):
 * every file in `input.files` either parses successfully or surfaces in
 * `parseErrors`. Tree-sitter recovers from syntax errors by inserting
 * MISSING nodes; we surface a ParseError when the root `hasError` so
 * users see the file had problems but keep the partial tree for the
 * walk.
 *
 * Parsed-project shape mirrors graph-rust: `Map<absoluteFilePath, {
 * tree, source }>`. The source string is held alongside the tree so
 * body slices can be extracted without re-parsing.
 */

import { readFileSync } from 'node:fs';
import { relative } from 'node:path';

import { logger } from '@opensip-tools/core';
import Parser from 'tree-sitter';
import Go from 'tree-sitter-go';

import type { ParseInput, ParseOutput, ParseError } from '@opensip-tools/graph';

/** Parsed Go source file: tree-sitter parse tree plus original source text. */
export interface GoParsedFile {
  readonly tree: Parser.Tree;
  readonly source: string;
}

/** Parsed Go project: map of file path → {@link GoParsedFile}. */
export interface GoParsedProject {
  readonly files: ReadonlyMap<string, GoParsedFile>;
}

/** Parses every Go source file in the input set into a {@link GoParsedProject}. */
export function parseProject(input: ParseInput): ParseOutput<GoParsedProject> {
  const parser = new Parser();
  // tree-sitter-go's `Language` type and tree-sitter's `Language` type
  // both come from CJS .d.ts files; they're structurally compatible at
  // runtime but don't unify under TS's `--strict` checks. Same cast as
  // graph-rust / graph-python.
  parser.setLanguage(Go as unknown as Parser.Language);

  const files = new Map<string, GoParsedFile>();
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
    files.set(path, { tree, source });
  }

  logger.info({
    evt: 'graph.parse.complete',
    module: 'graph:parse:go',
    files: files.size,
    parseErrors: parseErrors.length,
  });

  return { project: { files }, parseErrors };
}
