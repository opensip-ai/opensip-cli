// @fitness-ignore-file unbounded-memory -- reads source files one at a time; per-file memory bounded by source size (tree-sitter constraint)
/**
 * Rust parseProject — tree-sitter-rust.
 *
 * Per contract invariant I-7 (parseProject is total over `files`):
 * every file in `input.files` either parses successfully or surfaces
 * in `parseErrors`. Tree-sitter recovers from syntax errors by
 * inserting MISSING nodes; we surface a ParseError when the root
 * `hasError` so users see the file had problems but keep the partial
 * tree for the walk.
 *
 * Parsed-project shape mirrors lang-python: `Map<absoluteFilePath,
 * { tree, source }>`. The source string is held alongside the tree so
 * body slices can be extracted without re-parsing.
 */

import { readFileSync } from 'node:fs';
import { relative } from 'node:path';

import { logger } from '@opensip-tools/core';
import Parser from 'tree-sitter';
import Rust from 'tree-sitter-rust';

import type { ParseInput, ParseOutput, ParseError } from '@opensip-tools/graph';

export interface RustParsedFile {
  readonly tree: Parser.Tree;
  readonly source: string;
}

export interface RustParsedProject {
  readonly files: ReadonlyMap<string, RustParsedFile>;
}

export function parseProject(input: ParseInput): ParseOutput<RustParsedProject> {
  const parser = new Parser();
  // tree-sitter-rust's `Language` type and tree-sitter's `Language`
  // type both come from CJS .d.ts files; they're structurally
  // compatible at runtime but don't unify under TS's `--strict`
  // checks. Same cast as lang-python.
  parser.setLanguage(Rust as unknown as Parser.Language);

  const files = new Map<string, RustParsedFile>();
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
    module: 'graph:parse:rust',
    files: files.size,
    parseErrors: parseErrors.length,
  });

  return { project: { files }, parseErrors };
}
