import { describe, expect, it } from 'vitest';

import {
  allUnitsLabel,
  builtInOriginLabel,
  explicitUnitsLabel,
  PATTERN_BASED_LABEL,
  recipeDisplayInfo,
} from '../display.js';

import type { RecipeBase } from '../registry.js';

const recipe: RecipeBase = {
  id: 'demo',
  name: 'demo',
  displayName: 'Demo',
  description: 'A demo recipe',
  tags: ['smoke'],
};

describe('recipe display helpers', () => {
  it('copies recipe metadata and preserves tags', () => {
    expect(recipeDisplayInfo(recipe, 'all checks')).toEqual({
      name: 'demo',
      description: 'A demo recipe',
      tags: ['smoke'],
      selectionLabel: 'all checks',
    });
  });

  it('formats common selection labels', () => {
    expect(allUnitsLabel('rules')).toBe('all rules');
    expect(explicitUnitsLabel(1, 'check', 'checks')).toBe('1 check');
    expect(explicitUnitsLabel(3, 'rule', 'rules')).toBe('3 rules');
    expect(PATTERN_BASED_LABEL).toBe('pattern-based');
    expect(builtInOriginLabel(true)).toBe('built-in');
    expect(builtInOriginLabel(false)).toBe('user-defined');
  });
});
