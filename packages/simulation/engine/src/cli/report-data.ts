// @fitness-ignore-file batch-operation-limits -- `scenarios.getAll()` reads the per-run IN-MEMORY scenario registry (bounded by pack registration), not a database query; it mirrors fitness's checkRegistry.list() catalog read (which avoids the heuristic only by its method name).
/**
 * report-data contribution — simulation's inputs to the cross-tool HTML report.
 *
 * Parity with fitness's `collectFitnessReportData` and graph's `collectReportData`
 * (L6): sim returns ITS OWN dashboard catalog — the registered scenarios + sim
 * recipes — under DISTINCT keys (`simScenarioCatalog` / `simRecipeCatalog`) so the
 * CLI's `Object.assign` merge never clobbers another tool's catalog, and the
 * dashboard's Simulation tab can render them. Scope-only reads (no I/O); a run
 * without the sim subscope (or before any scenario pack loads) yields empty
 * arrays, never a throw. Sessions stay host-owned (the CLI loads the cross-tool
 * run history); this only contributes the catalog.
 */

import type { ToolScope } from '@opensip-cli/core';

/** Scenario catalog entry for the dashboard Simulation tab. */
export interface ScenarioCatalogEntry {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly description: string;
  readonly tags: readonly string[];
}

/** Sim recipe catalog entry for the dashboard Simulation tab. */
export interface SimRecipeCatalogEntry {
  readonly name: string;
  readonly displayName: string;
  readonly description: string;
  readonly tags: readonly string[];
}

/**
 * Simulation's report-data contribution. Returns the scenario + recipe catalogs
 * under sim-namespaced keys the dashboard consumes. A run without the sim
 * subscope contributes empty arrays (the tab renders its graceful empty state).
 */
export function collectSimulationReportData(scope: ToolScope): Record<string, unknown> {
  const sim = scope.simulation;
  // In-memory registry reads (only the scenarios/recipes registered this run,
  // bounded by pack registration) — catalog reads, not I/O queries; they mirror
  // fitness's checkRegistry.list(). See the file-level unbounded-memory waiver.
  const scenarios = sim ? sim.scenarios.getAll() : [];
  const recipes = sim ? sim.recipes.getAllRecipes() : [];

  const simScenarioCatalog: ScenarioCatalogEntry[] = scenarios.map((s) => ({
    id: s.id,
    name: s.name,
    kind: s.kind,
    description: s.description,
    tags: [...s.tags],
  }));
  const simRecipeCatalog: SimRecipeCatalogEntry[] = recipes.map((r) => ({
    name: r.name,
    displayName: r.displayName,
    description: r.description,
    tags: [...(r.tags ?? [])],
  }));
  return { simScenarioCatalog, simRecipeCatalog };
}
