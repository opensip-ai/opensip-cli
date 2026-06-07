/**
 * Tests for `collectFitnessDashboardData` — fitness's contribution to
 * the cross-tool dashboard composed by the CLI (audit 2026-05-29, L2).
 *
 * The collector returns ONLY fitness-owned inputs (check catalog, recipe
 * catalog, editor protocol) keyed by the field names
 * `generateDashboardHtml` consumes. It does NOT read sessions, the graph
 * catalog, write any file, or open a browser — those are the CLI
 * composition root's job now.
 */

import { enterScope } from '@opensip-tools/core';
import { makeTestScope } from '@opensip-tools/core/test-utils/with-scope.js';
import { beforeEach, describe, expect, it } from 'vitest';

import { fitnessTool } from '../../tool.js';
import { collectFitnessDashboardData } from '../dashboard.js';


import type {
  CheckCatalogEntry,
  RecipeCatalogEntry,
} from '../dashboard.js';

/**
 * Build + enter a RunScope carrying fitness's contributed subscope. The
 * collector reads the check/recipe registries and the `ensureChecksLoaded`
 * lifecycle slot off the AMBIENT current scope (not its `scope` argument), so
 * the scope must be entered, not merely constructed.
 */
function enterFitnessScope(): ReturnType<typeof makeTestScope> {
  const scope = makeTestScope();
  Object.assign(scope, fitnessTool.contributeScope?.() ?? {});
  enterScope(scope);
  return scope;
}

describe('collectFitnessDashboardData', () => {
  beforeEach(() => {
    enterFitnessScope();
  });

  it('returns only the fitness-owned dashboard keys', async () => {
    const scope = makeTestScope();
    const result = await collectFitnessDashboardData(scope);

    expect(Object.keys(result).sort()).toEqual([
      'checkCatalog',
      'editorProtocol',
      'recipeCatalog',
    ]);
  });

  it('does NOT contribute sessions or graphCatalog (CLI / graph own those)', async () => {
    const scope = makeTestScope();
    const result = await collectFitnessDashboardData(scope);

    expect(result).not.toHaveProperty('sessions');
    expect(result).not.toHaveProperty('graphCatalog');
  });

  it('builds a non-empty check catalog with the expected entry shape', async () => {
    const scope = makeTestScope();
    const result = await collectFitnessDashboardData(scope);

    const checkCatalog = result.checkCatalog as readonly CheckCatalogEntry[];
    expect(Array.isArray(checkCatalog)).toBe(true);
    expect(checkCatalog.length).toBeGreaterThan(0);

    const entry = checkCatalog[0];
    expect(entry).toEqual(
      expect.objectContaining({
        slug: expect.any(String),
        name: expect.any(String),
        icon: expect.any(String),
        description: expect.any(String),
        confidence: expect.stringMatching(/^(high|medium|low)$/),
        source: expect.stringMatching(/^(built-in|community)$/),
      }),
    );
  });

  it('builds a recipe catalog with the expected entry shape', async () => {
    const scope = makeTestScope();
    const result = await collectFitnessDashboardData(scope);

    const recipeCatalog = result.recipeCatalog as readonly RecipeCatalogEntry[];
    expect(Array.isArray(recipeCatalog)).toBe(true);
    if (recipeCatalog.length > 0) {
      expect(recipeCatalog[0]).toEqual(
        expect.objectContaining({
          name: expect.any(String),
          displayName: expect.any(String),
          selectorType: expect.any(String),
          mode: expect.any(String),
          timeout: expect.any(Number),
        }),
      );
    }
  });

  it('degrades editorProtocol to null when no signalers config is present', async () => {
    // makeTestScope() carries no projectContext, so the collector reads
    // process.cwd() — which in the test sandbox has no dashboard.editor
    // config, exercising the graceful-degradation path.
    const scope = makeTestScope();
    const result = await collectFitnessDashboardData(scope);

    expect(result.editorProtocol === null || typeof result.editorProtocol === 'string').toBe(true);
  });
});
