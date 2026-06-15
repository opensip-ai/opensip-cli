/**
 * Python parseProject — consumes `@opensip-cli/lang-python` (ADR-0010).
 *
 * `lang-python` is the canonical Python parse substrate: it owns the vendored
 * tree-sitter-python grammar and produces the `{ tree, source }` parsed-file
 * shape. The graph adapter no longer loads a grammar of its own; it binds the
 * shared `createParseProjectFromAdapter` driver to `pythonAdapter`. This
 * mirrors `graph-typescript`'s dependency on `lang-typescript`, generalizing
 * the `graph-* → lang-*` edge to Python. The parsed-project shape and the
 * downstream walk/resolve are unchanged.
 */

import {
  createParseProjectFromAdapter,
  type TreeSitterParsedFile,
  type TreeSitterParsedProject,
} from '@opensip-cli/graph-adapter-common';
import { pythonAdapter } from '@opensip-cli/lang-python';

/** Parsed Python source file: tree-sitter parse tree plus original source text. */
export type PythonParsedFile = TreeSitterParsedFile;

/**
 * Parsed Python project: map of normalized file path → {@link PythonParsedFile}.
 * Keyed by the absolute, realpath-normalized file path from discover.
 */
export type PythonParsedProject = TreeSitterParsedProject<PythonParsedFile>;

/** Parses every Python source file in the input set into a {@link PythonParsedProject}. */
export const parseProject = createParseProjectFromAdapter(pythonAdapter);
