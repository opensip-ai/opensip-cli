// @fitness-ignore-file module-coupling-fan-out -- composition root: the graph Tool descriptor wires every subcommand spec, the scope contribution, and the adapter/rule/recipe registries; high intra-project fan-out is inherent to a tool-wiring file (cf. the index.ts / code-paths.ts barrels that suppress the same check).
/**
 * graphTool — graph as a Tool plugin.
 *
 * Since launch (Phase 5 — the largest migration) the Commander wiring is
 * no longer hand-rolled: the tool exports declarative {@link CommandSpec}s
 * (`commandSpecs`) and the host's `mountCommandSpec` mounts them
 * (name/description/aliases, the ADR-0021 common flags, each command's
 * options/args) and owns the parse→handler→error→exit pipeline. This file owns
 * only the command-spec assembly + the per-run scope/report contributions; the
 * spec modules under `cli/graph/` own the option declarations and handler bodies.
 *
 * Per spec §10A AC-2 / AC-1: this module does NOT import from opensip-cli. It
 * receives the ToolCliContext interface from @opensip-cli/core.
 *
 * History: v0.2 originally registered three subcommands (`graph`,
 * `graph-orphans`, `graph-entry-points`). The orphans and entry-points
 * subcommands were folded into the unified `graph` output — all three data slices
 * (rules, entry points, catalog summary) are reachable via the single `graph`
 * invocation.
 */

import { logger, readPackageVersion } from '@opensip-cli/core';

// PR 3 of plan 2026-05-23-plan-graph-adapter-package-split.md: the
// engine no longer hosts adapter source. First-party adapters live in
// their own packages and register via the CLI's discovery walker
// (register-graph-adapters.ts). The historical engine-side bootstrap is
// gone.
import { graphFingerprintStrategy } from './baseline-strategy.js';
import {
  graphBaselineExportCommandSpec,
  graphCatalogExportCommandSpec,
  graphEquivalenceCheckCommandSpec,
  graphLookupCommandSpec,
  graphRecipesCommandSpec,
  graphSarifExportCommandSpec,
  graphShardWorkerCommandSpec,
  graphSymbolIndexCommandSpec,
} from './cli/graph/graph-aux-command-specs.js';
import { graphCommandSpec } from './cli/graph/graph-command-spec.js';
import { graphConfigDeclaration } from './cli/graph-config-schema.js';
import { graphRunWorkerCommandSpec } from './cli/graph-worker.js';
import { buildGraphRecipeCatalog, buildGraphRuleCatalog } from './cli/report-data.js';
import { createAdapterRegistry, currentAdapterRegistry } from './lang-adapter/registry.js';
import { CatalogRepo } from './persistence/catalog-repo.js';
import { graphReplayFromSession } from './persistence/session-replay.js';
import { createRecipeRegistry } from './recipes/registry.js';
import { createRulesRegistry } from './rules/registry.js';
// Side-effect import: ensures the RunScope.graph augmentation is
// loaded so `scope.graph` is correctly-typed here.
import './scope-augmentation.js';

import type { GraphLanguageAdapter } from './lang-adapter/types.js';
import type {
  CapabilityRegistrar,
  CommandSpec,
  ScopeContribution,
  Tool,
  ToolCliContext,
  ToolCommandDescriptor,
  ToolScope,
} from '@opensip-cli/core';
import type { DataStore } from '@opensip-cli/datastore';

// =============================================================================
// COMMAND DESCRIPTORS — used by --help listings and conflict detection.
// =============================================================================

const GRAPH: ToolCommandDescriptor = {
  name: 'graph',
  description:
    'Run static call-graph analysis (rules, entry points, catalog summary in one report)',
};

const GRAPH_LOOKUP: ToolCommandDescriptor = {
  name: 'graph-lookup',
  description: 'Look up function occurrences by simple name from the persisted catalog',
};

const GRAPH_SYMBOL_INDEX: ToolCommandDescriptor = {
  name: 'graph-symbol-index',
  description:
    'Emit a symbolindex.json artifact (name→file:line and file→names) from the persisted catalog',
};

const GRAPH_BASELINE_EXPORT: ToolCommandDescriptor = {
  name: 'graph-baseline-export',
  description: 'Export the graph gate baseline (JSON) from the datastore to a file',
};

const GRAPH_SHARD_WORKER: ToolCommandDescriptor = {
  name: 'graph-shard-worker',
  // Tier-3 (tool-command-surface-taxonomy): spawned by the sharded build, never
  // typed by a user. `visibility: 'internal'` is the machine-readable marker the
  // host hide pass keys on; the `[internal]` prefix is the human-readable backup.
  visibility: 'internal',
  description:
    '[internal] Build one shard from a spec file and emit a ShardBuildResult JSON (spawned by the sharded build)',
};

const GRAPH_EQUIVALENCE_CHECK: ToolCommandDescriptor = {
  name: 'graph-equivalence-check',
  // Tier-3 (tool-command-surface-taxonomy): a CI equivalence gate, never typed by
  // a user. `visibility: 'internal'` is the machine-readable marker the host hide
  // pass keys on; the `[internal]` prefix is the human-readable backup.
  visibility: 'internal',
  description:
    '[internal] Verify the sharded build is byte-equivalent to the exact build on a real repo (gates production edge divergence against a committed budget)',
};

const GRAPH_RUN_WORKER: ToolCommandDescriptor = {
  name: 'graph-run-worker',
  // Tier-3 (tool-command-surface-taxonomy): an IPC bootstrap entry point forked
  // by the live view, never typed by a user. `visibility: 'internal'` is the
  // machine-readable marker the host hide pass keys on; the `[internal]` prefix
  // is the human-readable backup.
  visibility: 'internal',
  description:
    '[internal] Run the graph build headless and stream progress + result over IPC (forked by the live view)',
};

const GRAPH_CATALOG_EXPORT: ToolCommandDescriptor = {
  name: 'catalog-export',
  description:
    'Run graph analysis and write the CatalogExport JSON document (symbols + edges + provenance) to a file',
};

const GRAPH_SARIF_EXPORT: ToolCommandDescriptor = {
  name: 'sarif-export',
  description: 'Run graph analysis and write OpenSIP-convention SARIF v2.1.0 findings to a file',
};

const GRAPH_RECIPES: ToolCommandDescriptor = {
  name: 'graph-recipes',
  description: 'List available graph recipes',
};

// =============================================================================
// COMMAND-SPEC ASSEMBLY
// =============================================================================

/**
 * graph's declarative command surface (launch Phase 5). The host mounts
 * each spec via `mountCommandSpec`; graph no longer touches Commander. Order is
 * preserved from the former `register()` mount order (graph, graph-lookup,
 * graph-shard-worker, graph-symbol-index, graph-baseline-export, catalog-export,
 * sarif-export, graph-recipes). The primary `graph` spec sets its own live-view
 * renderer up lazily inside its handler's interactive branch (no mount-time
 * `register()` hook in the spec-mounted world).
 */
const graphCommandSpecs: readonly CommandSpec<unknown, ToolCliContext>[] = [
  graphCommandSpec,
  graphLookupCommandSpec,
  graphShardWorkerCommandSpec,
  graphRunWorkerCommandSpec,
  graphSymbolIndexCommandSpec,
  graphBaselineExportCommandSpec,
  graphCatalogExportCommandSpec,
  graphSarifExportCommandSpec,
  graphRecipesCommandSpec,
  graphEquivalenceCheckCommandSpec,
];

/**
 * The graph tool's REAL registrar for its `graph-adapter` capability domain
 * (§5.3 / Phase 4). The host registers the domain from graph's manifest with a
 * deferred placeholder, then swaps in this registrar once graph's module is
 * loaded. A routed contribution (already shape-checked against the domain's
 * `requiredKeys: ['id']` schema by the host) is registered into THIS run's
 * scope-owned adapter registry — graph owns the registration semantics, the
 * host only routes.
 */
const registerGraphAdapter: CapabilityRegistrar = (contribution) => {
  currentAdapterRegistry().register(contribution as GraphLanguageAdapter);
};

/**
 * Per-run subscope contribution (D7). Called by the CLI's pre-action-hook
 * after constructing the scope and before entering it; the kernel installs
 * the returned `graph` slot. Fresh adapter + rule registries per run so
 * concurrent scopes carry independent graph state.
 *
 * Adapter seeding: the fresh adapter registry starts EMPTY. The generic
 * capability loader (§5.3/§4.5) discovers `graph-adapter` packages per run and
 * routes each through {@link registerGraphAdapter} into this scope's registry
 * (driven by the CLI pre-action hook), so `pickAdapter` resolves them — no
 * process-global discovered-adapters holder.
 */
function contributeScope(): ScopeContribution {
  return {
    graph: {
      adapters: createAdapterRegistry(),
      rules: createRulesRegistry(),
      recipes: createRecipeRegistry(),
    },
  };
}

/**
 * Dashboard-data contribution (audit 2026-05-29, L2). Graph owns its
 * Code Paths panel data: it returns the graph catalog (via its own
 * `CatalogRepo`) under the `graphCatalog` key that `generateDashboardHtml`
 * consumes. Best-effort — a missing/empty catalog yields no contribution
 * and the panel renders a no-data state. This is what lets the CLI
 * compose the cross-tool dashboard without fitness reaching into graph.
 *
 * The returned `graphCatalog.features` (Plan C) is populated when the
 * producing `graph` run requested the dashboard columns
 * (`['blast','scc','packageCoupling']`, see `executeGraph`); it rides on the
 * loaded contract for free via `loadCatalogContract`. This stays a pure read
 * — no on-demand engine compute at report-compose time (ADR-0006). When a
 * catalog was produced by a non-dashboard run, `features` is absent and the
 * panel renders a no-data state.
 */
function collectReportData(scope: ToolScope): Record<string, unknown> {
  // Rule + recipe catalogs are cheap, scope-only reads (no I/O). A run
  // without the graph subscope yields empty arrays, not a throw. These use
  // DISTINCT keys from fitness's `checkCatalog`/`recipeCatalog` (which the
  // CLI merges via Object.assign) so graph never clobbers fitness.
  const graphRuleCatalog = buildGraphRuleCatalog(scope);
  const graphRecipeCatalog = buildGraphRecipeCatalog(scope);

  const datastore = scope.datastore() as DataStore | undefined;
  if (!datastore) return { graphRuleCatalog, graphRecipeCatalog };
  try {
    return {
      graphCatalog: new CatalogRepo(datastore).loadCatalogContract(),
      graphRuleCatalog,
      graphRecipeCatalog,
    };
  } catch (error) {
    // No catalog (or an unreadable one) → the panel renders its no-data
    // state. Log at debug so the empty-result path is traceable rather
    // than silent.
    logger.debug({
      evt: 'graph.dashboard.catalog_load_failed',
      module: 'graph:tool',
      err: error instanceof Error ? error.message : String(error),
    });
    return { graphRuleCatalog, graphRecipeCatalog };
  }
}

/**
 * Per-tool contract version (ADR-0047). Exported from the public barrel.
 */
export const GRAPH_CONTRACT_VERSION = '1.0.0';

export const GRAPH_STABLE_ID = '3873f1c2-02a9-4719-930a-bca74b62b706';

export const graphTool: Tool = {
  metadata: {
    id: GRAPH_STABLE_ID, // stable UUID (per ADR-0048; matches Checks `id` naming)
    name: 'graph', // human key (previously the value in `id`)
    version: readPackageVersion(import.meta.url),
    description: 'Static call-graph + dead-end analysis',
  },
  commands: [
    GRAPH,
    GRAPH_LOOKUP,
    GRAPH_SYMBOL_INDEX,
    GRAPH_BASELINE_EXPORT,
    GRAPH_SHARD_WORKER,
    GRAPH_EQUIVALENCE_CHECK,
    GRAPH_RUN_WORKER,
    GRAPH_CATALOG_EXPORT,
    GRAPH_SARIF_EXPORT,
    GRAPH_RECIPES,
  ],
  // Launch Phase 5: graph declares its command surface; the host mounts
  // each spec via mountCommandSpec. The deprecated `register()` fallback is gone
  // — graph no longer touches Commander.
  commandSpecs: graphCommandSpecs,
  contributeScope,
  collectReportData,
  sessionReplay: {
    tool: 'graph',
    replaySession: graphReplayFromSession,
  },
  // ADR-0023 Phase 4: graph contributes its namespaced `graph:` Zod schema so
  // the host composes + strict-validates the whole config document before
  // dispatch. The schema-bearing `ToolConfigDeclaration` narrows to the
  // kernel-side `ToolConfigContribution` carrier (core carries no Zod).
  config: graphConfigDeclaration,
  // §5.3 Phase 4: graph owns the `graph-adapter` capability domain (declared in
  // its manifest). It supplies the REAL registrar so the host can replace the
  // manifest-time deferred placeholder once graph's module loads.
  capabilityRegistrars: { 'graph-adapter': registerGraphAdapter },
  // ADR-0036: graph's byte-preserved baseline identity (ruleId|filePath|line|col),
  // read by the host baseline/ratchet seams when graph stamps its gate envelope.
  fingerprintStrategy: graphFingerprintStrategy,
  // ADR-0047: per-tool contract version for graph's domain surface (rules, catalog,
  // execution model, adapter contract, etc.). Independent of core
  // TOOL_CONTRACT_VERSION. Declared under extensionPoints for discoverability
  // by hosts, agent-catalog, and third-party graph packs.
  extensionPoints: {
    graphContractVersion: GRAPH_CONTRACT_VERSION,
  },
};
