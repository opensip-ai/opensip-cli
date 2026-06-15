/**
 * @fileoverview Built-in graph recipes (Plan B, Phase 5 Task 5.3).
 */

import { describe, expect, it } from 'vitest';

import {
  builtInGraphRecipes,
  defaultGraphRecipe,
  isBuiltInGraphRecipe,
} from '../built-in-recipes.js';

describe('built-in graph recipes', () => {
  it('the default recipe selects all rules', () => {
    expect(defaultGraphRecipe.name).toBe('default');
    expect(defaultGraphRecipe.rules.type).toBe('all');
  });

  it('default is the first built-in recipe', () => {
    expect(builtInGraphRecipes[0]).toBe(defaultGraphRecipe);
  });

  it('isBuiltInGraphRecipe recognizes default and dead-code; rejects unknown', () => {
    expect(isBuiltInGraphRecipe('default')).toBe(true);
    expect(isBuiltInGraphRecipe('dead-code')).toBe(true);
    expect(isBuiltInGraphRecipe('nope')).toBe(false);
  });

  it('defineGraphRecipe derives a GRCP_-prefixed id and freezes the recipe', () => {
    expect(defaultGraphRecipe.id).toBe('GRCP_default');
    expect(Object.isFrozen(defaultGraphRecipe)).toBe(true);
  });
});
