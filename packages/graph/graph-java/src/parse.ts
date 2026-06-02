/**
 * Java parseProject — tree-sitter-java.
 *
 * The parse driver (read → parse → ParseError on failure, total over
 * `input.files` per invariant I-7) lives in
 * `@opensip-tools/graph-adapter-common`; this module binds it to the
 * tree-sitter-java grammar and re-exports the nominal Java parsed-project
 * types consumed by the resolver and tests.
 *
 * Parsed-project shape: `Map<absoluteFilePath, { tree, source }>`.
 */

import {
  createTreeSitterParseProject,
  type TreeSitterParsedFile,
  type TreeSitterParsedProject,
} from '@opensip-tools/graph-adapter-common';
import Java from 'tree-sitter-java';

/** Parsed Java source file: tree-sitter parse tree plus original source text. */
export type JavaParsedFile = TreeSitterParsedFile;

/** Parsed Java project: map of file path → {@link JavaParsedFile}. */
export type JavaParsedProject = TreeSitterParsedProject<JavaParsedFile>;

/** Parses every Java source file in the input set into a {@link JavaParsedProject}. */
export const parseProject = createTreeSitterParseProject<JavaParsedFile>({
  grammar: Java,
  languageId: 'java',
});
