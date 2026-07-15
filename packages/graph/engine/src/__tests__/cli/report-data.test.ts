import { describe, expect, it } from 'vitest';

import { buildGraphRecipeCatalog, buildGraphRuleCatalog } from '../../cli/report-data.js';

import type { ToolScope } from '@opensip-cli/core';

describe('graph report-data catalogs', () => {
  it('returns empty catalogs when the graph subscope is absent', () => {
    const scope = {} as ToolScope;
    expect(buildGraphRuleCatalog(scope)).toEqual([]);
    expect(buildGraphRecipeCatalog(scope)).toEqual([]);
  });

  it('maps rules and recipes, defaulting missing tags to an empty list', () => {
    const scope = {
      graph: {
        rules: {
          getAll: () => [
            { slug: 'large-function', defaultSeverity: 'warning' as const },
            { slug: 'cycle', defaultSeverity: 'error' as const },
          ],
        },
        recipes: {
          getAllRecipes: () => [
            {
              name: 'with-tags',
              displayName: 'With tags',
              description: 'tagged',
              tags: ['agent'],
              rules: { type: 'all' },
            },
            {
              name: 'no-tags',
              displayName: 'No tags',
              description: 'untagged',
              rules: { type: 'include', slugs: ['cycle'] },
            },
          ],
        },
      },
    } as unknown as ToolScope;

    expect(buildGraphRuleCatalog(scope)).toEqual([
      { slug: 'large-function', defaultSeverity: 'warning', source: 'built-in' },
      { slug: 'cycle', defaultSeverity: 'error', source: 'built-in' },
    ]);
    expect(buildGraphRecipeCatalog(scope)).toEqual([
      {
        name: 'with-tags',
        displayName: 'With tags',
        description: 'tagged',
        tags: ['agent'],
        selectorType: 'all',
      },
      {
        name: 'no-tags',
        displayName: 'No tags',
        description: 'untagged',
        tags: [],
        selectorType: 'include',
      },
    ]);
  });
});
