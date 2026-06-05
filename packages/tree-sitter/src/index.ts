/**
 * @opensip-tools/tree-sitter — the grammar-agnostic tree-sitter substrate
 * (ADR-0010). Sits between `@opensip-tools/core` and the `lang-*` / graph
 * adapters; depends on `web-tree-sitter` only, never on `@opensip-tools/graph`.
 *
 *   core → tree-sitter → { lang-*, graph-adapter-common }
 *
 * Provides: the parser lifecycle (`Parser.init` once, `loadGrammar`,
 * `createParser`, `parseToTree`), the neutral `ParsedFile` shape, and the
 * generic node accessors / AST helpers. Per-language grammars + node-kind
 * predicates live in each `lang-*` package.
 */

export * from './types.js'
export * from './lifecycle.js'
export * from './nodes.js'
