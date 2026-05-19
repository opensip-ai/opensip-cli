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
import type { GraphLanguageAdapter } from '../lang-adapter/types.js';

export { discoverFiles } from './discover.js';
export { parseProject } from './parse.js';
export type { RustParsedFile, RustParsedProject } from './parse.js';
export { walkProject } from './walk.js';
export { resolveCallSites } from './resolve.js';
export { cacheKey } from './cache-key.js';
export { rustRuleHints } from './rule-hints.js';

export const rustGraphAdapter: GraphLanguageAdapter<RustParsedProject> = {
  id: 'rust',
  fileExtensions: ['.rs'],
  displayName: 'Rust',
  discoverFiles: rustDiscoverFiles,
  parseProject: rustParseProject,
  walkProject: rustWalkProject,
  resolveCallSites: rustResolveCallSites,
  cacheKey: rustCacheKey,
  ruleHints: rustRuleHints,
};
