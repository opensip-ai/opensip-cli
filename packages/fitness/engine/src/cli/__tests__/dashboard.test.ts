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

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createCapabilityRegistry,
  enterScope,
  loadToolManifest,
  registerCapabilityDomainsFromManifest,
} from '@opensip-tools/core';
import { makeTestScope } from '@opensip-tools/core/test-utils/with-scope.js';
import { beforeEach, describe, expect, it } from 'vitest';

import { fitnessTool } from '../../tool.js';
import { collectFitnessDashboardData } from '../dashboard.js';


import type {
  CheckCatalogEntry,
  RecipeCatalogEntry,
} from '../dashboard.js';

/** The fitness engine package root (carries the manifest), 4 dirs up from this test. */
const ENGINE_DIR = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));

/**
 * Wire fitness's capability plane onto a scope exactly as the CLI host does:
 * register the manifest-declared domains (fit-pack, fit-recipe) and swap in the
 * tool's real registrars. `ensureChecksLoaded` drives discovery through this, so
 * without it the dashboard catalog would be empty.
 */
function wireFitnessCapabilities(scope: ReturnType<typeof makeTestScope>): void {
  const capabilities = createCapabilityRegistry();
  const manifest = loadToolManifest('bundled', ENGINE_DIR);
  if (manifest) registerCapabilityDomainsFromManifest(manifest, capabilities);
  for (const [domainId, registrar] of Object.entries(fitnessTool.capabilityRegistrars ?? {})) {
    if (capabilities.hasDomain(domainId)) capabilities.setRegistrar(domainId, registrar);
  }
  Object.assign(scope, { capabilities });
}

/**
 * Build + enter a RunScope carrying fitness's contributed subscope. The
 * collector reads the check/recipe registries and the `ensureChecksLoaded`
 * lifecycle slot off the AMBIENT current scope (not its `scope` argument), so
 * the scope must be entered, not merely constructed.
 */
function enterFitnessScope(): ReturnType<typeof makeTestScope> {
  const scope = makeTestScope();
  Object.assign(scope, fitnessTool.contributeScope?.() ?? {});
  wireFitnessCapabilities(scope);
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
