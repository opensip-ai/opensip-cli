/**
 * Export-surface lock for `@opensip-cli/fitness`.
 *
 * The public barrel is the marketplace contract surface documented in
 * `docs/public/10-concepts/04-contract-surfaces.md`: the check / recipe /
 * plugin authoring API plus `fitnessTool`. This test pins the exact set of
 * **runtime (value) exports** so the barrel cannot silently re-grow to leak
 * engine internals (registries, recipe service, gate primitives,
 * `FitBaselineRepo`, CLI handlers, …) — the regression the round-4 boundary
 * audit found and ADR-0013 curated away.
 *
 * Scope note: type-only exports are erased at runtime and cannot be asserted
 * here. They are governed by the barrel source plus the dependency-cruiser
 * `no-cross-package-internal` rule. Adding a *value* export to the barrel is a
 * deliberate minor-version act and must be reflected in EXPECTED below (and in
 * the contract-surfaces doc); removing one is a major change.
 */

import { describe, expect, it } from 'vitest';

import * as barrel from '../index.js';

/** The complete, intended set of runtime value exports. Keep alphabetised. */
const EXPECTED_VALUE_EXPORTS = [
  'applyCheckDisplay',
  'buildImportGraph',
  'clearCurrentRecipeCheckConfig',
  'collectCheckObjects',
  'createPathMatcher',
  'defineCheck',
  'defineRecipe',
  'defineRegexListCheck',
  'execAbortable',
  'extractSnippet',
  'fileCache',
  'findStronglyConnectedComponents',
  'fitnessTool',
  'getCheckConfig',
  'getCheckDisplayName',
  'getCheckIcon',
  'getLineNumber',
  'isAPIFile',
  'isCheck',
  'isCommentLine',
  'isInsideStringLiteral',
  'isTestFile',
  'makeDisplayHelpers',
  'readPackageVersion',
  'setCurrentRecipeCheckConfig',
  'stripStringLiterals',
  'stripStringsAndComments',
  'stripStringsAndCommentsPreservingPositions',
  'tool',
  'FITNESS_CONTRACT_VERSION',
].sort();

describe('@opensip-cli/fitness public barrel', () => {
  it('exposes exactly the curated value-export surface', () => {
    const actual = Object.keys(barrel)
      .filter((k) => barrel[k as keyof typeof barrel] !== undefined)
      .sort();
    expect(actual).toEqual(EXPECTED_VALUE_EXPORTS);
  });

  it('exposes `fitnessTool` (and its `tool` alias) as the Tool descriptor', () => {
    expect(barrel.fitnessTool).toBeDefined();
    expect(barrel.fitnessTool.identity).toEqual({
      name: 'fitness',
      aliases: ['fit'],
      layoutKey: 'fit',
    });
    expect(barrel.fitnessTool.metadata.name).toBe('fitness');
    expect(barrel.fitnessTool.metadata.id).toBe('afd68bd3-ff3c-4935-a5b6-76d8fc7a5224');
    expect(barrel.tool).toBe(barrel.fitnessTool);
  });

  it('does NOT leak engine internals through the barrel', () => {
    // Spot-check the worst former offenders: a persistence repo, the recipe
    // service, the registries, and a CLI handler must not be reachable here.
    for (const leak of [
      'FitBaselineRepo',
      'FitnessRecipeService',
      'FitnessRecipeRegistry',
      'defaultRegistry',
      'CheckRegistry',
      'TargetRegistry',
      'listChecks',
      'saveBaseline',
      'compareToBaseline',
      'ensureChecksLoaded',
    ]) {
      expect(barrel).not.toHaveProperty(leak);
    }
  });
});
