/**
 * @fileoverview `@opensip-cli/graph/internal` — engine internals exposed
 * ONLY for the cross-package adapter test suites (graph-typescript et al.).
 *
 * This is NOT public API. Production code in other packages must not import
 * from `@opensip-cli/graph/internal` (enforced by dependency-cruiser per
 * ADR-0009). The individual built-in rule instances live here because the
 * public way to run a rule is via a recipe (by id); only the rule unit tests
 * need the raw rule object to call `.evaluate(...)` directly.
 */

// Index builder — used by the adapter rule tests to assemble a catalog's
// indexes before invoking a rule's `.evaluate(...)`. The dashboard has its own
// index builder; nothing in production consumes the engine's.
export { buildIndexes } from './pipeline/indexes.js';

// `GraphConfig` — the engine's tuning/config data type. No external consumer
// imports it from the public barrel; rule unit tests that construct a config to
// drive `.evaluate(...)` import it from here instead (ADR-0009 surface policy).
export type { GraphConfig } from './types.js';

export { alwaysThrowsBranchRule } from './rules/always-throws-branch.js';
export { noSideEffectPathRule } from './rules/no-side-effect-path.js';
export { duplicatedFunctionBodyRule } from './rules/duplicated-function-body.js';
export { orphanSubtreeRule } from './rules/orphan-subtree.js';

// ── Orchestration / CLI-handler surface (ADR-0009, Finding 3) ──────
//
// These drive the six-stage pipeline and the `graph` CLI command. The
// production path reaches them via `graphTool.commandSpecs` (host-mounted,
// and the parent repo via the `catalog-export` subcommand), never by importing these
// symbols — so they are private. Only the cross-package adapter and CLI
// telemetry test suites import them, exercising the orchestrator end to
// end without going through Commander.
export { runGraph, GRAPH_STAGES } from './cli/orchestrate.js';
export type {
  GraphStage,
  GraphProgressEvent,
  GraphProgressCallback,
  RunGraphInput,
  RunGraphResult,
} from './cli/orchestrate.js';
export { executeGraph, buildUnifiedReportLines } from './cli/graph.js';
export type { UnifiedReportInput } from './cli/graph.js';

// The graph live verbose/detail per-unit table node. Internal — exported only
// so the host-side live/static parity proof
// (`packages/cli/src/ui/__tests__/graph-live-static-parity.test.tsx`) can assert
// it renders byte-identically to the static `envelopeToTableView` table.
export { graphDoneTableNode } from './cli/graph-envelope-view.js';

// `CatalogRepo` — the engine's SQLite/Drizzle catalog persistence repo. Used
// internally by graph (orchestrator cache, `tool.ts` report contribution,
// `lookup`/`catalog-export`). It was briefly on the public barrel for fitness's
// report command; with that coupling gone it is demoted here — a concrete
// repository is not a module contract (boundary audit 2026-06-05). Any future
// out-of-package read should go through a narrow catalog-read contract, not this.
export { CatalogRepo } from './persistence/catalog-repo.js';
export { MemoryPressureError } from './cli/pressure-monitor.js';
export {
  HEAP_TARGETS,
  decideHeapTargetMb,
  systemHasMemoryFor,
  runHeapPreflight,
  totalSystemMemoryMb,
} from './cli/heap-preflight.js';
export type { Shard, ShardBuildResult } from './cli/orchestrate/shard-model.js';
