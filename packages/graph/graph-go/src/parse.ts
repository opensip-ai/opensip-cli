/**
 * Go parseProject — consumes `@opensip-tools/lang-go` (ADR-0010).
 *
 * `lang-go` is the canonical Go parse substrate: it owns the vendored
 * tree-sitter-go grammar and produces the `{ tree, source }` parsed-file shape.
 * The graph adapter no longer loads a grammar of its own; it binds the shared
 * `createParseProjectFromAdapter` driver to `goAdapter`. The parsed-project
 * shape and the downstream walk/resolve are unchanged.
 */

import {
  createParseProjectFromAdapter,
  type TreeSitterParsedFile,
  type TreeSitterParsedProject,
} from '@opensip-tools/graph-adapter-common';
import { goAdapter } from '@opensip-tools/lang-go';

/** Parsed Go source file: tree-sitter parse tree plus original source text. */
export type GoParsedFile = TreeSitterParsedFile;

/** Parsed Go project: map of file path → {@link GoParsedFile}. */
export type GoParsedProject = TreeSitterParsedProject<GoParsedFile>;

/** Parses every Go source file in the input set into a {@link GoParsedProject}. */
export const parseProject = createParseProjectFromAdapter(goAdapter);
