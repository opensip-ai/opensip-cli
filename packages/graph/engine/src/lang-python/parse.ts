/**
 * Python parseProject — tree-sitter-python.
 *
 * Per contract invariant I-7 (parseProject is total over `files`):
 * every file in `input.files` either parses successfully or surfaces
 * in `parseErrors`. Tree-sitter recovers from syntax errors gracefully
 * (it builds a partial tree marked with ERROR nodes); we surface a
 * ParseError when the root node `hasError` so the user knows the file
 * had problems, but we still keep the partial tree for the walk.
 *
 * The parsed-project shape is `Map<absoluteFilePath, { tree, source }>`.
 * Both the tree and the original source text are needed: tree-sitter's
 * SyntaxNode.text already extracts text from the source it was parsed
 * with, but we hold the raw bytes ourselves to compute body slices for
 * hashing without re-parsing.
 */

import { readFileSync } from 'node:fs';
import { relative } from 'node:path';

import { logger } from '@opensip-tools/core';
import Parser from 'tree-sitter';
import Python from 'tree-sitter-python';

import type { ParseInput, ParseOutput } from '../lang-adapter/types.js';
import type { ParseError } from '../types.js';

export interface PythonParsedFile {
  readonly tree: Parser.Tree;
  readonly source: string;
}

export interface PythonParsedProject {
  /** Keyed by the absolute, realpath-normalized file path from discover. */
  readonly files: ReadonlyMap<string, PythonParsedFile>;
}

export function parseProject(input: ParseInput): ParseOutput<PythonParsedProject> {
  const parser = new Parser();
  // tree-sitter-python's `Language` type and tree-sitter's `Language`
  // type both come from CJS .d.ts files; their structural shapes match
  // at runtime but don't unify under TS's `--strict` checks. The cast
  // is safe — we exercised it in the test fixture parses end-to-end.
  parser.setLanguage(Python as unknown as Parser.Language);

  const files = new Map<string, PythonParsedFile>();
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
    module: 'graph:parse:python',
    files: files.size,
    parseErrors: parseErrors.length,
  });

  return { project: { files }, parseErrors };
}
