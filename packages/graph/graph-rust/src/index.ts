/**
 * @opensip-tools/graph — Rust language adapter.
 *
 * Lands in PR 6 of plan docs/plans/10-graph-language-pluggability.md.
 * Exposes `rustGraphAdapter`, a `GraphLanguageAdapter` backed by
 * tree-sitter-rust.
 *
 * Per-rule fidelity: same as Python (mostly `'medium'`; `'low'` for
 * ambiguous matches). The adapter has no symbol table, so trait
 * dispatch and method-on-generic resolution degrade to name-only.
 * Receiver-type narrowing (e.g. `Foo::method(...)`) is best-effort
 * and slightly lifts confidence when the receiver type is statically
 * present in the call expression itself.
 *
 * File layout mirrors `lang-python/`:
 *   discoverFiles    → ./discover.ts (Cargo.toml / Cargo.lock + glob fallback)
 *   parseProject     → ./parse.ts
 *   walkProject      → ./walk.ts
 *   resolveCallSites → ./resolve.ts
 *   cacheKey         → ./cache-key.ts (`rs-…`)
 *   ruleHints        → ./rule-hints.ts
 *
 * Files outside this subtree are forbidden from importing tree-sitter
 * directly; the dep-cruiser rule
 * `graph-no-tree-sitter-import-outside-lang-packs` enforces it.
 */

import { cacheKey as rustCacheKey } from './cache-key.js';
import { discoverFiles as rustDiscoverFiles } from './discover.js';
import { parseProject as rustParseProject } from './parse.js';
import { resolveCallSites as rustResolveCallSites } from './resolve.js';
import { rustRuleHints } from './rule-hints.js';
import { walkProject as rustWalkProject } from './walk.js';

import type { RustParsedProject } from './parse.js';
import type { GraphLanguageAdapter } from '@opensip-tools/graph';

export const rustGraphAdapter = {
  id: 'rust',
  fileExtensions: ['.rs'],
  displayName: 'Rust',
  discoverFiles: rustDiscoverFiles,
  parseProject: rustParseProject,
  walkProject: rustWalkProject,
  resolveCallSites: rustResolveCallSites,
  cacheKey: rustCacheKey,
  ruleHints: rustRuleHints,
} satisfies GraphLanguageAdapter<RustParsedProject>;

/**
 * Discovery contract: external adapter packs export `adapter` (the
 * GraphLanguageAdapter) and `metadata`. The CLI bootstrap registers
 * `adapter` into the adapter registry after a successful `import()`.
 */
export { rustGraphAdapter as adapter };
export const metadata = {
  id: rustGraphAdapter.id,
  displayName: rustGraphAdapter.displayName,
  fileExtensions: rustGraphAdapter.fileExtensions,
} as const;

// Re-export the parsed-project type and the rule hints constant. PR 3
// drains the engine-side re-exports because graph-rust is now the
// canonical home; cross-package tests in graph-typescript import them
// from here.
export type { RustParsedProject } from './parse.js';
export { rustRuleHints } from './rule-hints.js';
