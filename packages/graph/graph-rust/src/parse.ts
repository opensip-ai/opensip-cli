/**
 * Rust parseProject — consumes `@opensip-tools/lang-rust` (ADR-0010).
 *
 * `lang-rust` is the canonical Rust parse substrate: it owns the vendored
 * tree-sitter-rust grammar and produces the `{ tree, source }` parsed-file
 * shape. The graph adapter no longer loads a grammar of its own; it binds the
 * shared `createParseProjectFromAdapter` driver to `rustAdapter`. The
 * parsed-project shape and the downstream walk/resolve are unchanged.
 */

import {
  createParseProjectFromAdapter,
  type TreeSitterParsedFile,
  type TreeSitterParsedProject,
} from '@opensip-tools/graph-adapter-common';
import { rustAdapter } from '@opensip-tools/lang-rust';

/** Parsed Rust source file: tree-sitter parse tree plus original source text. */
export type RustParsedFile = TreeSitterParsedFile;

/** Parsed Rust project: map of file path → {@link RustParsedFile}. */
export type RustParsedProject = TreeSitterParsedProject<RustParsedFile>;

/** Parses every Rust source file in the input set into a {@link RustParsedProject}. */
export const parseProject = createParseProjectFromAdapter(rustAdapter);
