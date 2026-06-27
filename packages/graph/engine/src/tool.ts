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

import { createToolScope, defineTool, logger, readPackageVersion } from '@opensip-cli/core';

// PR 3 of plan 2026-05-23-plan-graph-adapter-package-split.md: the
// engine no longer hosts adapter source. First-party adapters live in
// their own packages and register via the CLI's discovery walker
// (register-graph-adapters.ts). The historical engine-side bootstrap is
// gone.
import { graphFingerprintStrategy } from './baseline-strategy.js';
import {
  graphEquivalenceCheckCommandSpec,
  graphExportCommandSpec,
  graphImpactCommandSpec,
  graphIndexGroupedCommandSpec,
  graphListCommandSpec,
  graphLookupGroupedCommandSpec,
  graphRecipesGroupedCommandSpec,
  graphShardWorkerCommandSpec,
} from './cli/graph/graph-aux-command-specs.js';
import { graphCommandSpec } from './cli/graph/graph-command-spec.js';
import { graphConfigDeclaration } from './cli/graph-config-schema.js';
import { graphRunWorkerCommandSpec } from './cli/graph-worker.js';
import { buildGraphRecipeCatalog, buildGraphRuleCatalog } from './cli/report-data.js';
import { GRAPH_IDENTITY } from './identity.js';
import { createAdapterRegistry, currentAdapterRegistry } from './lang-adapter/registry.js';
import { CatalogRepo } from './persistence/catalog-repo.js';
import { graphReplayFromSession } from './persistence/session-replay.js';
import { createRecipeRegistry } from './recipes/registry.js';
import { createRulesRegistry } from './rules/registry.js';
// Side-effect import: ensures the RunScope.graph augmentation is
// loaded so `scope.graph` is correctly-typed here.
import './scope-augmentation.js';

import type { GraphLanguageAdapter } from './lang-adapter/types.js';
import type { CapabilityRegistrar, Tool, ToolScope } from '@opensip-cli/core';
import type { DataStore } from '@opensip-cli/datastore';

// =============================================================================
// COMMAND-SPEC ASSEMBLY
// =============================================================================

/**
 * graph's declarative command surface. The host mounts each spec via
 * `mountCommandSpec`; graph no longer touches Commander. The primary `graph`
 * spec sets its own live-view renderer up lazily inside its handler's
 * interactive branch (no mount-time `register()` hook in the spec-mounted
 * world). The canonical surface is the nested `<tool> <verb>` grammar — `graph
 * export` / `graph recipes` / `graph lookup` / `graph index` / `graph list` —
 * the legacy flat-root aliases were removed.
 */
const graphCommandSpecs = [
  graphCommandSpec,
  graphShardWorkerCommandSpec,
  graphRunWorkerCommandSpec,
  // Canonical nested export — mounts as `graph export` under the `graph` primary
  // via the nested-mount capability.
  graphExportCommandSpec,
  // Grouped Tier-2 children — `graph recipes` / `graph lookup` / `graph index` /
  // `graph list` nest under the `graph` primary via the nested-mount capability.
  graphRecipesGroupedCommandSpec,
  graphLookupGroupedCommandSpec,
  graphIndexGroupedCommandSpec,
  graphListCommandSpec,
  graphImpactCommandSpec,
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

const graphScope = createToolScope({
  slot: 'graph',
  create: () => ({
    adapters: createAdapterRegistry(),
    rules: createRulesRegistry(),
    recipes: createRecipeRegistry(),
  }),
});

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

export const graphTool: Tool = defineTool({
  identity: GRAPH_IDENTITY,
  metadata: {
    id: GRAPH_STABLE_ID,
    version: readPackageVersion(import.meta.url),
    description: 'Static call-graph + dead-end analysis',
  },
  commandSpecs: graphCommandSpecs,
  extensionPoints: {
    contractVersions: {
      graph: GRAPH_CONTRACT_VERSION,
    },
    contributeScope: graphScope.contributeScope,
    collectReportData,
    sessionReplay: {
      replaySession: graphReplayFromSession,
    },
    config: {
      schema: graphConfigDeclaration.schema,
      defaults: graphConfigDeclaration.defaults,
      env: graphConfigDeclaration.env,
    },
    capabilityRegistrars: { 'graph-adapter': registerGraphAdapter },
    fingerprintStrategy: graphFingerprintStrategy,
  },
});
