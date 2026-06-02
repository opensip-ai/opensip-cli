/**
 * Go parseProject — tree-sitter-go.
 *
 * The parse driver (read → parse → ParseError on failure, total over
 * `input.files` per invariant I-7) lives in
 * `@opensip-tools/graph-adapter-common`; this module binds it to the
 * tree-sitter-go grammar and re-exports the nominal Go parsed-project
 * types consumed by the resolver and tests.
 *
 * Parsed-project shape: `Map<absoluteFilePath, { tree, source }>`. The
 * source string is held alongside the tree so body slices can be
 * extracted without re-parsing.
 */

import {
  createTreeSitterParseProject,
  type TreeSitterParsedFile,
  type TreeSitterParsedProject,
} from '@opensip-tools/graph-adapter-common';
import Go from 'tree-sitter-go';

/** Parsed Go source file: tree-sitter parse tree plus original source text. */
export type GoParsedFile = TreeSitterParsedFile;

/** Parsed Go project: map of file path → {@link GoParsedFile}. */
export type GoParsedProject = TreeSitterParsedProject<GoParsedFile>;

/** Parses every Go source file in the input set into a {@link GoParsedProject}. */
export const parseProject = createTreeSitterParseProject<GoParsedFile>({
  grammar: Go,
  languageId: 'go',
});
