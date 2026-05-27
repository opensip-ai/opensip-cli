import { describe, it, expect, vi } from 'vitest';

import { RecipeRegistry, type RecipeBase } from '../../recipes/registry.js';
import { registerRecipesFromMod } from '../recipe-loader.js';

// Phase 7 fills in real cases. Scaffold confirms the public surface is callable.
describe('recipe-loader (scaffold)', () => {
  it('returns zero when mod is undefined', () => {
    const registry = new RecipeRegistry<RecipeBase>();
    const onWarn = vi.fn();
    const result = registerRecipesFromMod(undefined, registry, {
      namespace: 'test',
      onWarn,
    });
    expect(result.recipesRegistered).toBe(0);
    expect(onWarn).not.toHaveBeenCalled();
  });

  it('returns zero when mod.recipes is not an array', () => {
    const registry = new RecipeRegistry<RecipeBase>();
    const onWarn = vi.fn();
    const result = registerRecipesFromMod({ recipes: 'not-an-array' }, registry, {
      namespace: 'test',
      onWarn,
    });
    expect(result.recipesRegistered).toBe(0);
    expect(onWarn).not.toHaveBeenCalled();
  });
});
