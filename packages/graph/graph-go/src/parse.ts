/**
 * Go parseProject — web-tree-sitter + vendored tree-sitter-go.wasm.
 *
 * The parse driver (read → parse → ParseError on failure, total over
 * `input.files` per invariant I-7) lives in
 * `@opensip-tools/graph-adapter-common`; this module loads the vendored Go
 * grammar WASM and binds the driver to it, then re-exports the nominal Go
 * parsed-project types consumed by the resolver and tests.
 *
 * The grammar is loaded via a module top-level `await Language.load(...)`.
 * `graph-adapter-common`'s parse module (statically imported above) runs
 * `await Parser.init()` first, so the WASM runtime is ready before this
 * load. Adapter discovery `import()`s this package, so both awaits settle
 * before the engine calls `parseProject` — keeping `parseProject`
 * synchronous (see graph-adapter-common/parse.ts). The `.wasm` is vendored
 * under `../wasm/` and shipped in the package `files`.
 *
 * Parsed-project shape: `Map<absoluteFilePath, { tree, source }>`. The
 * source string is held alongside the tree so body slices can be
 * extracted without re-parsing.
 */

import { fileURLToPath } from 'node:url';

import {
  createTreeSitterParseProject,
  type TreeSitterParsedFile,
  type TreeSitterParsedProject,
} from '@opensip-tools/graph-adapter-common';
import { Language } from 'web-tree-sitter';

const Go = await Language.load(
  fileURLToPath(new URL('../wasm/tree-sitter-go.wasm', import.meta.url)),
);

/** Parsed Go source file: tree-sitter parse tree plus original source text. */
export type GoParsedFile = TreeSitterParsedFile;

/** Parsed Go project: map of file path → {@link GoParsedFile}. */
export type GoParsedProject = TreeSitterParsedProject<GoParsedFile>;

/** Parses every Go source file in the input set into a {@link GoParsedProject}. */
export const parseProject = createTreeSitterParseProject<GoParsedFile>({
  grammar: Go,
  languageId: 'go',
});
