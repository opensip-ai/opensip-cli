/**
 * @fileoverview Graph dashboard-data catalog builders.
 *
 * Mirrors fitness's `collectFitnessDashboardData` (`fitness/.../cli/dashboard.ts`):
 * graph contributes a rule catalog + recipe catalog the dashboard renders on
 * the Code Paths tab (Catalog + Recipes subtabs). These entry types are graph
 * domain vocabulary, so they live here; the dashboard consumes them
 * structurally via `DashboardInput` (typed `readonly unknown[]`) — the same
 * opaque-payload model the fitness catalogs use, keeping `@opensip-tools/dashboard`
 * decoupled from `@opensip-tools/graph`.
 *
 * **Distinct keys.** Graph contributes `graphRuleCatalog` / `graphRecipeCatalog`
 * — NOT `checkCatalog` / `recipeCatalog`, which are fitness-owned globals the
 * CLI merges via `Object.assign`. Reusing those keys would clobber fitness.
 */

import type { ToolScope } from '@opensip-tools/core';

/** Rule catalog entry for dashboard display. */
export interface GraphRuleCatalogEntry {
  readonly slug: string;
  readonly defaultSeverity: 'error' | 'warning';
  readonly source: 'built-in';
}

/** Recipe catalog entry for dashboard display. */
export interface GraphRecipeCatalogEntry {
  readonly name: string;
  readonly displayName: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly selectorType: string;
}

/**
 * Build the rule catalog from the scope's rule registry. All five built-in
 * rules are first-party, so `source` is hardcoded `'built-in'` for now —
 * graph has no community-rule namespace registry yet (documented; a richer
 * display can land with Plan D rules). Returns `[]` when the graph subscope
 * is absent.
 */
export function buildGraphRuleCatalog(scope: ToolScope): GraphRuleCatalogEntry[] {
  const rules = scope.graph?.rules.getAll() ?? [];
  return rules.map((rule) => ({
    slug: rule.slug,
    defaultSeverity: rule.defaultSeverity,
    source: 'built-in' as const,
  }));
}

/**
 * Build the recipe catalog from the scope's recipe registry. Graph recipes
 * carry no execution block, so the entry has no `mode`/`timeout` (unlike
 * fitness's `RecipeCatalogEntry`). Returns `[]` when the graph subscope is
 * absent.
 */
export function buildGraphRecipeCatalog(scope: ToolScope): GraphRecipeCatalogEntry[] {
  const recipes = scope.graph?.recipes.getAllRecipes() ?? [];
  return recipes.map((recipe) => ({
    name: recipe.name,
    displayName: recipe.displayName,
    description: recipe.description,
    tags: recipe.tags ?? [],
    selectorType: recipe.rules.type,
  }));
}
