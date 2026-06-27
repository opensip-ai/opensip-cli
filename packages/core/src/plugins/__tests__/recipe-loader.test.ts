import { describe, it, expect, vi } from 'vitest';

import { RecipeRegistry, type RecipeBase } from '../../recipes/registry.js';
import { registerRecipesFromMod } from '../recipe-loader.js';

interface TestRecipe extends RecipeBase {
  readonly id: string;
  readonly name: string;
  readonly displayName: string;
  readonly description: string;
}

function makeRecipe(id: string, name: string): TestRecipe {
  return { id, name, displayName: name, description: `Recipe ${name}` };
}

describe('registerRecipesFromMod', () => {
  it('returns zero when mod is undefined', () => {
    const registry = new RecipeRegistry<TestRecipe>();
    const onWarn = vi.fn();
    const result = registerRecipesFromMod(undefined, registry, {
      namespace: 'test',
      onWarn,
    });
    expect(result.recipesRegistered).toBe(0);
    expect(onWarn).not.toHaveBeenCalled();
  });

  it('returns zero when mod is null', () => {
    const registry = new RecipeRegistry<TestRecipe>();
    const onWarn = vi.fn();
    const result = registerRecipesFromMod(null, registry, {
      namespace: 'test',
      onWarn,
    });
    expect(result.recipesRegistered).toBe(0);
    expect(onWarn).not.toHaveBeenCalled();
  });

  it('returns zero when mod has no recipes field', () => {
    const registry = new RecipeRegistry<TestRecipe>();
    const onWarn = vi.fn();
    const result = registerRecipesFromMod({ checks: [] }, registry, {
      namespace: 'test',
      onWarn,
    });
    expect(result.recipesRegistered).toBe(0);
    expect(onWarn).not.toHaveBeenCalled();
  });

  it('returns zero when mod.recipes is not an array', () => {
    const registry = new RecipeRegistry<TestRecipe>();
    const onWarn = vi.fn();
    const result = registerRecipesFromMod({ recipes: 'oops' }, registry, {
      namespace: 'test',
      onWarn,
    });
    expect(result.recipesRegistered).toBe(0);
    expect(onWarn).not.toHaveBeenCalled();
  });

  it('registers a valid recipe and counts it', () => {
    const registry = new RecipeRegistry<TestRecipe>();
    const onWarn = vi.fn();
    const recipe = makeRecipe('r1', 'recipe-one');
    const result = registerRecipesFromMod({ recipes: [recipe] }, registry, {
      namespace: 'test',
      onWarn,
    });
    expect(result.recipesRegistered).toBe(1);
    expect(registry.has('recipe-one')).toBe(true);
    expect(onWarn).not.toHaveBeenCalled();
  });

  it('registers multiple valid recipes', () => {
    const registry = new RecipeRegistry<TestRecipe>();
    const onWarn = vi.fn();
    const result = registerRecipesFromMod(
      { recipes: [makeRecipe('r1', 'first'), makeRecipe('r2', 'second')] },
      registry,
      { namespace: 'test', onWarn },
    );
    expect(result.recipesRegistered).toBe(2);
    expect(registry.size).toBe(2);
  });

  it('warns on a recipe missing id', () => {
    const registry = new RecipeRegistry<TestRecipe>();
    const onWarn = vi.fn();
    const result = registerRecipesFromMod(
      { recipes: [{ name: 'no-id', displayName: 'x', description: 'x' }] },
      registry,
      { namespace: '@my-co/fit', onWarn },
    );
    expect(result.recipesRegistered).toBe(0);
    expect(onWarn).toHaveBeenCalledWith(
      'plugin.recipe.invalid_item',
      expect.stringContaining('@my-co/fit recipes[0] is not a valid Recipe object'),
      { index: 0 },
    );
  });

  it('warns on a recipe missing name', () => {
    const registry = new RecipeRegistry<TestRecipe>();
    const onWarn = vi.fn();
    const result = registerRecipesFromMod(
      { recipes: [{ id: 'no-name', displayName: 'x', description: 'x' }] },
      registry,
      { namespace: 'test', onWarn },
    );
    expect(result.recipesRegistered).toBe(0);
    expect(onWarn).toHaveBeenCalled();
  });

  it('warns on null / non-object recipe entries', () => {
    const registry = new RecipeRegistry<TestRecipe>();
    const onWarn = vi.fn();
    const result = registerRecipesFromMod({ recipes: [null, 42, 'string', undefined] }, registry, {
      namespace: 'test',
      onWarn,
    });
    expect(result.recipesRegistered).toBe(0);
    expect(onWarn).toHaveBeenCalledTimes(4);
  });

  it('skips duplicates without throwing and without counting', () => {
    const registry = new RecipeRegistry<TestRecipe>();
    const onWarn = vi.fn();
    const onDuplicate = vi.fn();
    registry.register(makeRecipe('r1', 'incumbent'));

    const result = registerRecipesFromMod(
      { recipes: [makeRecipe('r1', 'incumbent'), makeRecipe('r2', 'fresh')] },
      registry,
      { namespace: 'test', onWarn, onDuplicate },
    );
    expect(result.recipesRegistered).toBe(1);
    expect(registry.size).toBe(2);
    expect(onDuplicate).toHaveBeenCalledTimes(1);
    expect(onDuplicate).toHaveBeenCalledWith(expect.objectContaining({ id: 'r1' }));
  });

  it('treats name-collision as duplicate even when id differs', () => {
    const registry = new RecipeRegistry<TestRecipe>();
    const onWarn = vi.fn();
    const onDuplicate = vi.fn();
    registry.register(makeRecipe('r1', 'shared-name'));

    const result = registerRecipesFromMod(
      { recipes: [makeRecipe('r2', 'shared-name')] },
      registry,
      { namespace: 'test', onWarn, onDuplicate },
    );
    expect(result.recipesRegistered).toBe(0);
    expect(onDuplicate).toHaveBeenCalledTimes(1);
  });

  it('mixed valid + malformed + duplicate produces the correct count', () => {
    const registry = new RecipeRegistry<TestRecipe>();
    const onWarn = vi.fn();
    registry.register(makeRecipe('r1', 'first'));

    const result = registerRecipesFromMod(
      {
        recipes: [
          makeRecipe('r1', 'first'), // duplicate id
          makeRecipe('r2', 'second'), // valid
          { id: 'r3' }, // malformed (no name)
          makeRecipe('r4', 'fourth'), // valid
        ],
      },
      registry,
      { namespace: 'test', onWarn },
    );
    expect(result.recipesRegistered).toBe(2);
    expect(onWarn).toHaveBeenCalledTimes(1);
    expect(registry.has('second')).toBe(true);
    expect(registry.has('fourth')).toBe(true);
  });

  it('onDuplicate is optional and absence is fine', () => {
    const registry = new RecipeRegistry<TestRecipe>();
    const onWarn = vi.fn();
    registry.register(makeRecipe('r1', 'incumbent'));
    // No onDuplicate callback — should not throw.
    expect(() =>
      registerRecipesFromMod({ recipes: [makeRecipe('r1', 'incumbent')] }, registry, {
        namespace: 'test',
        onWarn,
      }),
    ).not.toThrow();
  });
});
