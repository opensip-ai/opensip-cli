// @fitness-ignore-file unbounded-memory -- reads source files one at a time; per-file memory bounded by source size (tree-sitter constraint)
/**
 * Java parseProject — tree-sitter-java.
 *
 * Per contract invariant I-7 (parseProject is total over `files`):
 * every file in `input.files` either parses successfully or surfaces in
 * `parseErrors`. Tree-sitter recovers from syntax errors by inserting
 * MISSING nodes; we surface a ParseError when the root `hasError` so
 * users see the file had problems but keep the partial tree for the
 * walk.
 *
 * Parsed-project shape mirrors graph-go: `Map<absoluteFilePath,
 * { tree, source }>`.
 */

import { readFileSync } from 'node:fs';
import { relative } from 'node:path';

import { logger } from '@opensip-tools/core';
import Parser from 'tree-sitter';
import Java from 'tree-sitter-java';

import type { ParseInput, ParseOutput, ParseError } from '@opensip-tools/graph';

/** Parsed Java source file: tree-sitter parse tree plus original source text. */
export interface JavaParsedFile {
  readonly tree: Parser.Tree;
  readonly source: string;
}

/** Parsed Java project: map of file path → {@link JavaParsedFile}. */
export interface JavaParsedProject {
  readonly files: ReadonlyMap<string, JavaParsedFile>;
}

/** Parses every Java source file in the input set into a {@link JavaParsedProject}. */
export function parseProject(input: ParseInput): ParseOutput<JavaParsedProject> {
  const parser = new Parser();
  // Same CJS-typing cast as graph-rust / graph-python / graph-go.
  parser.setLanguage(Java as unknown as Parser.Language);

  const files = new Map<string, JavaParsedFile>();
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
    module: 'graph:parse:java',
    files: files.size,
    parseErrors: parseErrors.length,
  });

  return { project: { files }, parseErrors };
}
