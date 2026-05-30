/**
 * @opensip-tools/graph — Python language adapter.
 *
 * Lands in PR 5 of plan docs/plans/10-graph-language-pluggability.md.
 * Exposes `pythonGraphAdapter`, a `GraphLanguageAdapter` backed by
 * tree-sitter-python.
 *
 * Per-rule fidelity (plan §6 row "Tree-sitter adapter"): mostly
 * `'medium'` confidence on calls; `'low'` when multiple catalog
 * entries share a simple name. The adapter has no symbol table.
 *
 * File layout mirrors `lang-typescript/`:
 *   discoverFiles    → ./discover.ts
 *   parseProject     → ./parse.ts
 *   walkProject      → ./walk.ts
 *   resolveCallSites → ./resolve.ts
 *   cacheKey         → ./cache-key.ts
 *   ruleHints        → ./rule-hints.ts
 *
 * Files outside this subtree are forbidden from importing tree-sitter
 * directly; the dep-cruiser rule
 * `graph-no-tree-sitter-import-outside-lang-packs` enforces it.
 */

import { cacheKey as pythonCacheKey } from './cache-key.js';
import { discoverFiles as pythonDiscoverFiles } from './discover.js';
import { parseProject as pythonParseProject } from './parse.js';
import { resolveCallSites as pythonResolveCallSites } from './resolve.js';
import { pythonRuleHints } from './rule-hints.js';
import { walkProject as pythonWalkProject } from './walk.js';

import type { PythonParsedProject } from './parse.js';
import type { GraphLanguageAdapter } from '@opensip-tools/graph';

export const pythonGraphAdapter: GraphLanguageAdapter<PythonParsedProject> = {
  id: 'python',
  fileExtensions: ['.py'],
  displayName: 'Python',
  discoverFiles: pythonDiscoverFiles,
  parseProject: pythonParseProject,
  walkProject: pythonWalkProject,
  resolveCallSites: pythonResolveCallSites,
  cacheKey: pythonCacheKey,
  ruleHints: pythonRuleHints,
};

/**
 * Discovery contract: external adapter packs export `adapter` (the
 * GraphLanguageAdapter) and `metadata`. The CLI bootstrap registers
 * `adapter` into the adapter registry after a successful `import()`.
 */
export { pythonGraphAdapter as adapter };
export const metadata = {
  id: pythonGraphAdapter.id,
  displayName: pythonGraphAdapter.displayName,
  fileExtensions: pythonGraphAdapter.fileExtensions,
} as const;

// Re-export the parsed-project type and the rule hints constant. Both
// were transitionally exposed through the engine's barrel during PR
// 1b; PR 2 drains the engine-side re-exports because graph-python is
// now the canonical home.
export type { PythonParsedProject } from './parse.js';
export { pythonRuleHints } from './rule-hints.js';
