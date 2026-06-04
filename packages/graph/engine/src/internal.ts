/**
 * @fileoverview `@opensip-tools/graph/internal` — engine internals exposed
 * ONLY for the cross-package adapter test suites (graph-typescript et al.).
 *
 * This is NOT public API. Production code in other packages must not import
 * from `@opensip-tools/graph/internal` (enforced by dependency-cruiser per
 * ADR-0009). The individual built-in rule instances live here because the
 * public way to run a rule is via a recipe (by id); only the rule unit tests
 * need the raw rule object to call `.evaluate(...)` directly.
 */

// Index builder — used by the adapter rule tests to assemble a catalog's
// indexes before invoking a rule's `.evaluate(...)`. The dashboard has its own
// index builder; nothing in production consumes the engine's.
export { buildIndexes } from './pipeline/indexes.js';

export { alwaysThrowsBranchRule } from './rules/always-throws-branch.js';
export { noSideEffectPathRule } from './rules/no-side-effect-path.js';
export { duplicatedFunctionBodyRule } from './rules/duplicated-function-body.js';
export { orphanSubtreeRule } from './rules/orphan-subtree.js';
