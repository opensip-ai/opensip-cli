/**
 * Java parseProject — web-tree-sitter + vendored tree-sitter-java.wasm.
 *
 * The parse driver (read → parse → ParseError on failure, total over
 * `input.files` per invariant I-7) lives in
 * `@opensip-tools/graph-adapter-common`; this module loads the vendored
 * Java grammar WASM and binds the driver to it, then re-exports the
 * nominal Java parsed-project types consumed by the resolver and tests.
 *
 * The grammar is loaded via a module top-level `await Language.load(...)`.
 * `graph-adapter-common`'s parse module (statically imported above) runs
 * `await Parser.init()` first, so the WASM runtime is ready before this
 * load. Adapter discovery `import()`s this package, so both awaits settle
 * before the engine calls `parseProject` — keeping `parseProject`
 * synchronous (see graph-adapter-common/parse.ts). The `.wasm` is vendored
 * under `../wasm/` and shipped in the package `files`.
 *
 * Parsed-project shape: `Map<absoluteFilePath, { tree, source }>`.
 */

import { fileURLToPath } from 'node:url';

import {
  createTreeSitterParseProject,
  type TreeSitterParsedFile,
  type TreeSitterParsedProject,
} from '@opensip-tools/graph-adapter-common';
import { Language } from 'web-tree-sitter';

const Java = await Language.load(
  fileURLToPath(new URL('../wasm/tree-sitter-java.wasm', import.meta.url)),
);

/** Parsed Java source file: tree-sitter parse tree plus original source text. */
export type JavaParsedFile = TreeSitterParsedFile;

/** Parsed Java project: map of file path → {@link JavaParsedFile}. */
export type JavaParsedProject = TreeSitterParsedProject<JavaParsedFile>;

/** Parses every Java source file in the input set into a {@link JavaParsedProject}. */
export const parseProject = createTreeSitterParseProject<JavaParsedFile>({
  grammar: Java,
  languageId: 'java',
});
