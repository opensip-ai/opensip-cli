/**
 * Python parseProject — web-tree-sitter + vendored tree-sitter-python.wasm.
 *
 * The parse driver (read → parse → ParseError on failure, total over
 * `input.files` per invariant I-7) lives in
 * `@opensip-tools/graph-adapter-common`; this module loads the vendored
 * Python grammar WASM and binds the driver to it, then re-exports the
 * nominal Python parsed-project types consumed by the resolver and tests.
 *
 * The grammar is loaded via a module top-level `await Language.load(...)`.
 * `graph-adapter-common`'s parse module (statically imported above) runs
 * `await Parser.init()` at its own top level first, so the WASM runtime is
 * ready before this load. Adapter discovery `import()`s this package, so
 * both awaits settle before the engine calls `parseProject` — keeping
 * `parseProject` synchronous (see graph-adapter-common/parse.ts). The
 * `.wasm` is vendored under `../wasm/` and shipped in the package `files`.
 *
 * The parsed-project shape is `Map<absoluteFilePath, { tree, source }>`.
 * Both the tree and the original source text are needed: we hold the raw
 * bytes ourselves to compute body slices for hashing without re-parsing.
 */

import { fileURLToPath } from 'node:url';

import {
  createTreeSitterParseProject,
  type TreeSitterParsedFile,
  type TreeSitterParsedProject,
} from '@opensip-tools/graph-adapter-common';
import { Language } from 'web-tree-sitter';

const Python = await Language.load(
  fileURLToPath(new URL('../wasm/tree-sitter-python.wasm', import.meta.url)),
);

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
