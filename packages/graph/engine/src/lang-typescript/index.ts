/**
 * @opensip-tools/graph — TypeScript language adapter (PR 2 surface).
 *
 * Bundles every TypeScript-specific module under `lang-typescript/` so
 * the engine's orchestrator and tests have a single place to import
 * from. PR 2 is intentionally a pure re-export: there is no
 * `GraphLanguageAdapter` interface yet — that arrives in PR 3 of plan
 * docs/plans/10-graph-language-pluggability.md.
 *
 * Files outside this subtree are forbidden from importing the TypeScript
 * compiler API directly; the dep-cruiser rule
 * `graph-no-typescript-import-outside-lang-typescript` enforces it.
 */

export {
  walkProgram,
  dispatchVisitor,
  isInlineCallable,
} from './walk.js';
export type {
  CallSiteRecord,
  WalkInput,
  WalkOutput,
} from './walk.js';

export { discoverFiles } from './discover.js';
export type { DiscoveryInput, DiscoveryOutput } from './discover.js';

export {
  resolveEdges,
  resolveEdgesFromRecords,
} from './edges.js';
export type {
  EdgeResolutionInput,
  EdgeResolutionOutput,
  EdgeResolutionFromRecordsInput,
} from './edges.js';

export { buildInventory } from './inventory.js';
export type { InventoryInput, InventoryOutput } from './inventory.js';

export { normalizeProjectDir } from './normalize-project-dir.js';

// Visitor + resolver contract types live deep in the subtree but
// callers (the engine's public barrel) want a stable public surface.
export type { EdgeResolver, ResolverContext } from './edge-resolvers/types.js';
export type { InventoryVisitor, VisitorContext } from './inventory-visitors/types.js';
