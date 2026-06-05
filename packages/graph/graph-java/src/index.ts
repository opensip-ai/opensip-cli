/**
 * @opensip-tools/graph — Java language adapter.
 *
 * Sibling of graph-rust, graph-python, and graph-go. Backed by
 * tree-sitter-java.
 *
 * Per-rule fidelity: same name-based resolution profile as the other
 * tree-sitter adapters. Mostly `'medium'` for single-match identifiers;
 * `'low'` for ambiguous matches. Receiver-type narrowing is NOT done
 * because Java's `obj.method()` (instance call) and `Class.method()`
 * (static call) are AST-indistinguishable without a type checker.
 *
 * File layout mirrors graph-go/:
 *   discoverFiles    → ./discover.ts (Maven/Gradle build files + glob)
 *   parseProject     → ./parse.ts
 *   walkProject      → ./walk.ts
 *   resolveCallSites → ./resolve.ts
 *   cacheKey         → ./cache-key.ts (`java-…`)
 *   ruleHints        → ./rule-hints.ts
 */

import { cacheKey as javaCacheKey } from './cache-key.js';
import { discoverFiles as javaDiscoverFiles } from './discover.js';
import { parseProject as javaParseProject } from './parse.js';
import { resolveCallSites as javaResolveCallSites } from './resolve.js';
import { javaRuleHints } from './rule-hints.js';
import { walkProject as javaWalkProject } from './walk.js';

import type { JavaParsedProject } from './parse.js';
import type { GraphLanguageAdapter } from '@opensip-tools/graph';

export const javaGraphAdapter = {
  id: 'java',
  fileExtensions: ['.java'],
  displayName: 'Java',
  discoverFiles: javaDiscoverFiles,
  parseProject: javaParseProject,
  walkProject: javaWalkProject,
  resolveCallSites: javaResolveCallSites,
  cacheKey: javaCacheKey,
  ruleHints: javaRuleHints,
} satisfies GraphLanguageAdapter<JavaParsedProject>;

/** Plugin discovery contract: exported as `adapter` for runtime registration. */
export { javaGraphAdapter as adapter };
export const metadata = {
  id: javaGraphAdapter.id,
  displayName: javaGraphAdapter.displayName,
  fileExtensions: javaGraphAdapter.fileExtensions,
} as const;

export type { JavaParsedProject } from './parse.js';
export { javaRuleHints } from './rule-hints.js';
