/**
 * Python parseProject — tree-sitter-python.
 *
 * The parse driver (read → parse → ParseError on failure, total over
 * `input.files` per invariant I-7) lives in
 * `@opensip-tools/graph-adapter-common`; this module binds it to the
 * tree-sitter-python grammar and re-exports the nominal Python
 * parsed-project types consumed by the resolver and tests.
 *
 * The parsed-project shape is `Map<absoluteFilePath, { tree, source }>`.
 * Both the tree and the original source text are needed: we hold the raw
 * bytes ourselves to compute body slices for hashing without re-parsing.
 */

import {
  createTreeSitterParseProject,
  type TreeSitterParsedFile,
  type TreeSitterParsedProject,
} from '@opensip-tools/graph-adapter-common';
import Python from 'tree-sitter-python';

/** Parsed Python source file: tree-sitter parse tree plus original source text. */
export type PythonParsedFile = TreeSitterParsedFile;

/**
 * Parsed Python project: map of normalized file path → {@link PythonParsedFile}.
 * Keyed by the absolute, realpath-normalized file path from discover.
 */
export type PythonParsedProject = TreeSitterParsedProject<PythonParsedFile>;

/** Parses every Python source file in the input set into a {@link PythonParsedProject}. */
export const parseProject = createTreeSitterParseProject<PythonParsedFile>({
  grammar: Python,
  languageId: 'python',
});
