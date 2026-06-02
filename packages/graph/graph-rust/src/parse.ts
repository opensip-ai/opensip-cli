/**
 * Rust parseProject — tree-sitter-rust.
 *
 * The parse driver (read → parse → ParseError on failure, total over
 * `input.files` per invariant I-7) lives in
 * `@opensip-tools/graph-adapter-common`; this module binds it to the
 * tree-sitter-rust grammar and re-exports the nominal Rust parsed-project
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
import Rust from 'tree-sitter-rust';

/** Parsed Rust source file: tree-sitter parse tree plus original source text. */
export type RustParsedFile = TreeSitterParsedFile;

/** Parsed Rust project: map of file path → {@link RustParsedFile}. */
export type RustParsedProject = TreeSitterParsedProject<RustParsedFile>;

/** Parses every Rust source file in the input set into a {@link RustParsedProject}. */
export const parseProject = createTreeSitterParseProject<RustParsedFile>({
  grammar: Rust,
  languageId: 'rust',
});
