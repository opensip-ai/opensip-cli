/**
 * Export-surface lock for `@opensip-tools/graph`.
 *
 * The public barrel is the marketplace contract surface: `graphTool` plus the
 * `GraphLanguageAdapter` authoring API (adapter registry, edge/body-digest
 * helpers, recipe/rule authoring) that external adapter packs consume. This
 * test pins the exact set of **runtime (value) exports** so the barrel cannot
 * silently re-grow to leak engine internals — the regression the 2026-06-05
 * boundary audit found, where the concrete `CatalogRepo` persistence repo sat
 * on the contract with no external consumer (now demoted to
 * `@opensip-tools/graph/internal`).
 *
 * Scope note: type-only exports are erased at runtime and cannot be asserted
 * here. Adding a *value* export to the barrel is a deliberate minor-version act
 * and must be reflected in EXPECTED below (and in the package catalog);
 * removing one is a major change.
 */

import { describe, expect, it } from 'vitest';

import * as barrel from '../index.js';

/** The complete, intended set of runtime value exports. Keep alphabetised. */
const EXPECTED_VALUE_EXPORTS = [
  'CALL_EDGE_TEXT_MAX',
  'CREATION_EDGE_PREFIX',
  'CREATION_EDGE_TEXT_MAX',
  // Env-surface specs (release 2.12.0, §5.12) — imported by the CLI to aggregate
  // the env-surface reference doc.
  'GRAPH_ENV_SPECS',
  'GraphAdapterRegistry',
  'GraphAdapterSelector',
  'GraphRecipeRegistry',
  'appendEdge',
  'builtInGraphRecipes',
  'builtInGraphRecipesByName',
  // Cross-package resolution primitives — the (import specifier + callee name) →
  // unique exported SOURCE occurrence model BOTH engines link `@scope/pkg` calls
  // through (the exact↔sharded convergence contract). Part of the adapter
  // surface alongside the edge-helpers and body-digest primitives.
  'buildExportIndex',
  'buildPackageManifestIndex',
  'buildPackageManifestIndexFromRoots',
  'createAdapterRegistry',
  'createMutableStats',
  'createRecipeRegistry',
  'currentAdapterRegistry',
  'currentGraphRecipes',
  'deadCodeGraphRecipe',
  'defaultGraphRecipe',
  'defineGraphRecipe',
  'defineRule',
  'graphTool',
  'hashBody',
  'isBuiltInGraphRecipe',
  'linkExported',
  'normalizeWhitespace',
  'ownerEdgeKey',
  'pickAdapter',
  'pushCreationEdge',
  'resolveCrossPackageCall',
  'resolveRecipeToRules',
  'resolveSpecifierToPackage',
  'tool',
  'truncateForCallEdge',
].sort();

describe('@opensip-tools/graph public barrel', () => {
  it('exposes exactly the curated value-export surface', () => {
    const actual = Object.keys(barrel)
      .filter((k) => barrel[k as keyof typeof barrel] !== undefined)
      .sort();
    expect(actual).toEqual(EXPECTED_VALUE_EXPORTS);
  });

  it('exposes `graphTool` (and its `tool` alias) as the Tool descriptor', () => {
    expect(barrel.graphTool).toBeDefined();
    expect(barrel.graphTool.metadata.id).toBe('graph');
    expect(barrel.tool).toBe(barrel.graphTool);
  });

  it('does NOT leak engine internals through the barrel', () => {
    // CatalogRepo (persistence) + the orchestration/rule internals live on
    // `@opensip-tools/graph/internal`, never the public barrel.
    for (const leak of [
      'CatalogRepo',
      'runGraph',
      'executeGraph',
      'buildIndexes',
      'buildUnifiedReportLines',
      'orphanSubtreeRule',
      'duplicatedFunctionBodyRule',
      'MemoryPressureError',
      'GRAPH_STAGES',
    ]) {
      expect(barrel).not.toHaveProperty(leak);
    }
  });
});
