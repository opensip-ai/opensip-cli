/**
 * @opensip-cli/graph — Go language adapter.
 *
 * Sibling of graph-rust and graph-python. Backed by tree-sitter-go.
 *
 * Per-rule fidelity: same name-based resolution profile as Python/Rust.
 * Mostly `'medium'` for single-match identifiers; `'low'` for ambiguous
 * matches. The adapter has no symbol table, so method-on-instance,
 * package-qualified call, and free-function call are distinguishable
 * at the AST shape level but cannot be type-narrowed without a real
 * type checker.
 *
 * File layout mirrors graph-rust/:
 *   discoverFiles    → ./discover.ts (go.mod / go.sum + glob fallback)
 *   parseProject     → ./parse.ts
 *   walkProject      → ./walk.ts
 *   resolveCallSites → ./resolve.ts
 *   cacheKey         → ./cache-key.ts (`go-…`)
 *   ruleHints        → ./rule-hints.ts
 */

import { cacheKey as goCacheKey } from './cache-key.js';
import { discoverFiles as goDiscoverFiles } from './discover.js';
import { parseProject as goParseProject } from './parse.js';
import { resolveCallSites as goResolveCallSites } from './resolve.js';
import { goRuleHints } from './rule-hints.js';
import { walkProject as goWalkProject } from './walk.js';

import type { GoParsedProject } from './parse.js';
import type { GraphLanguageAdapter } from '@opensip-cli/graph';

export const goGraphAdapter = {
  id: 'go',
  fileExtensions: ['.go'],
  displayName: 'Go',
  discoverFiles: goDiscoverFiles,
  parseProject: goParseProject,
  walkProject: goWalkProject,
  resolveCallSites: goResolveCallSites,
  cacheKey: goCacheKey,
  ruleHints: goRuleHints,
} satisfies GraphLanguageAdapter<GoParsedProject>;

/** Plugin discovery contract: exported as `adapter` for runtime registration. */
export { goGraphAdapter as adapter };
export const metadata = {
  id: goGraphAdapter.id,
  displayName: goGraphAdapter.displayName,
  fileExtensions: goGraphAdapter.fileExtensions,
} as const;

export type { GoParsedProject } from './parse.js';
export { goRuleHints } from './rule-hints.js';
