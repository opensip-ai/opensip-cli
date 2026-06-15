/**
 * web-tree-sitter lifecycle — the grammar-agnostic half lifted out of
 * `graph-adapter-common/parse.ts` (ADR-0010). No `@opensip-cli/graph`
 * coupling: this layer knows nothing of `ParseInput`/`ParseOutput`. The
 * per-project parse driver (which owns those graph types) stays in
 * graph-adapter-common; `lang-*` adapters call `parseToTree` per file.
 *
 * ## Sync parse over an async runtime (the load-bearing seam)
 *
 * `web-tree-sitter` needs a one-time async init (`Parser.init()`) and a
 * one-time async grammar load (`Language.load(<wasm>)`), but
 * `parser.parse(source)` is synchronous once a language is set. We confine
 * the async to module top-level `await Parser.init()` here — every consumer
 * statically imports this module, so the WASM runtime is ready before any
 * adapter's own top-level `await loadGrammar(<wasm>)`.
 */

import { Parser, Language, type Tree } from 'web-tree-sitter';

// One-time WASM runtime init. Top-level await — every consumer statically
// imports this module — guarantees the runtime is ready before any adapter's
// `loadGrammar(<wasm>)` (which also runs at module top level).
await Parser.init();

/** Load a tree-sitter grammar from a `.wasm` path (adapter module top level). */
export async function loadGrammar(wasmPath: string): Promise<Language> {
  return Language.load(wasmPath);
}

/**
 * Create a parser bound to `grammar`. Adapters create one per grammar at
 * module load and reuse it across every `parseToTree` call — tree-sitter
 * parsers are reusable and stateless per parse, so reuse yields identical
 * trees with no per-call allocation.
 */
export function createParser(grammar: Language): Parser {
  const parser = new Parser();
  parser.setLanguage(grammar);
  return parser;
}

/**
 * Parse `source` into a tree. Returns the tree (possibly with
 * `rootNode.hasError` — tree-sitter recovers with MISSING nodes; the partial
 * tree is retained, matching the graph parse contract). Returns `null` only
 * when web-tree-sitter yields no tree (no language set / aborted callback —
 * neither applies here). Never swallows a thrown error: a throwing parse
 * propagates to the caller's project loop, which records a `ParseError`.
 */
export function parseToTree(parser: Parser, source: string): Tree | null {
  return parser.parse(source);
}
