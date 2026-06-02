/**
 * Rust parseProject — web-tree-sitter + vendored tree-sitter-rust.wasm.
 *
 * The parse driver (read → parse → ParseError on failure, total over
 * `input.files` per invariant I-7) lives in
 * `@opensip-tools/graph-adapter-common`; this module loads the vendored
 * Rust grammar WASM and binds the driver to it, then re-exports the
 * nominal Rust parsed-project types consumed by the resolver and tests.
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

const Rust = await Language.load(
  fileURLToPath(new URL('../wasm/tree-sitter-rust.wasm', import.meta.url)),
);

/** Parsed Rust source file: tree-sitter parse tree plus original source text. */
export type RustParsedFile = TreeSitterParsedFile;

/** Parsed Rust project: map of file path → {@link RustParsedFile}. */
export type RustParsedProject = TreeSitterParsedProject<RustParsedFile>;

/** Parses every Rust source file in the input set into a {@link RustParsedProject}. */
export const parseProject = createTreeSitterParseProject<RustParsedFile>({
  grammar: Rust,
  languageId: 'rust',
});
