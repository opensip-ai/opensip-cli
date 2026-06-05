/**
 * Java parseProject — consumes `@opensip-tools/lang-java` (ADR-0010).
 *
 * `lang-java` is the canonical Java parse substrate: it owns the vendored
 * tree-sitter-java grammar and produces the `{ tree, source }` parsed-file
 * shape. The graph adapter no longer loads a grammar of its own; it binds the
 * shared `createParseProjectFromAdapter` driver to `javaAdapter`. The
 * parsed-project shape and the downstream walk/resolve are unchanged.
 */

import {
  createParseProjectFromAdapter,
  type TreeSitterParsedFile,
  type TreeSitterParsedProject,
} from '@opensip-tools/graph-adapter-common';
import { javaAdapter } from '@opensip-tools/lang-java';

/** Parsed Java source file: tree-sitter parse tree plus original source text. */
export type JavaParsedFile = TreeSitterParsedFile;

/** Parsed Java project: map of file path → {@link JavaParsedFile}. */
export type JavaParsedProject = TreeSitterParsedProject<JavaParsedFile>;

/** Parses every Java source file in the input set into a {@link JavaParsedProject}. */
export const parseProject = createParseProjectFromAdapter(javaAdapter);
