import { describe, it, expect } from 'vitest';

import { builtInRecipes, builtInRecipesByName, isBuiltInRecipe } from '../built-in-recipes.js';

describe('built-in recipes', () => {
  it('has expected recipes', () => {
    expect(builtInRecipesByName.has('default')).toBe(true);
    expect(builtInRecipesByName.has('quick-smoke')).toBe(true);
    expect(builtInRecipesByName.has('security')).toBe(true);
    expect(builtInRecipesByName.has('backend')).toBe(true);
    expect(builtInRecipesByName.has('frontend')).toBe(true);
    expect(builtInRecipesByName.has('ci')).toBe(true);
    expect(builtInRecipesByName.has('pre-commit')).toBe(true);
    expect(builtInRecipesByName.has('pre-release')).toBe(true);
    expect(builtInRecipesByName.has('nightly-full')).toBe(true);
    expect(builtInRecipesByName.has('architecture')).toBe(true);
  });

  it('builtInRecipes array matches builtInRecipesByName map', () => {
    expect(builtInRecipes.length).toBe(builtInRecipesByName.size);
    for (const recipe of builtInRecipes) {
      expect(builtInRecipesByName.get(recipe.name)).toBe(recipe);
    }
  });

  it('all recipes have required fields', () => {
    for (const [name, recipe] of builtInRecipesByName) {
      expect(recipe.name).toBe(name);
      expect(recipe.id).toBeDefined();
      expect(recipe.displayName).toBeDefined();
      expect(recipe.description).toBeDefined();
      expect(recipe.checks).toBeDefined();
      expect(recipe.execution).toBeDefined();
      expect(recipe.reporting).toBeDefined();
    }
  });

  it('all recipes have valid check selector types', () => {
    const validTypes = ['all', 'explicit', 'pattern', 'tags'];
    for (const [, recipe] of builtInRecipesByName) {
      expect(validTypes).toContain(recipe.checks.type);
    }
  });

  it('default recipe includes all checks', () => {
    const defaultRecipe = builtInRecipesByName.get('default');
    expect(defaultRecipe?.checks.type).toBe('all');
  });

  it('pre-release recipe includes all checks', () => {
    const preRelease = builtInRecipesByName.get('pre-release');
    expect(preRelease?.checks.type).toBe('all');
  });

  it('quick-smoke recipe uses explicit check list', () => {
    const quickSmoke = builtInRecipesByName.get('quick-smoke');
    expect(quickSmoke?.checks.type).toBe('explicit');
    if (quickSmoke?.checks.type === 'explicit') {
      expect(quickSmoke.checks.checkIds.length).toBeGreaterThan(0);
    }
  });

  it('explicit recipes use namespaced check slugs (ADR-0106)', () => {
    for (const recipe of builtInRecipes) {
      if (recipe.checks.type !== 'explicit') continue;
      for (const checkId of recipe.checks.checkIds) {
        expect(checkId).toMatch(/^@opensip-cli\/checks-(?:universal|typescript):/);
      }
    }
  });

  it('backend recipe uses pattern selector', () => {
    const backend = builtInRecipesByName.get('backend');
    expect(backend?.checks.type).toBe('pattern');
    if (backend?.checks.type === 'pattern') {
      expect(backend.checks.include.length).toBeGreaterThan(0);
    }
  });

  it('architecture recipe uses tags selector', () => {
    const arch = builtInRecipesByName.get('architecture');
    expect(arch?.checks.type).toBe('tags');
    if (arch?.checks.type === 'tags') {
      expect(arch.checks.include).toContain('architecture');
    }
  });

  it('all recipes have valid execution modes', () => {
    for (const [, recipe] of builtInRecipesByName) {
      expect(['parallel', 'sequential']).toContain(recipe.execution.mode);
    }
  });

  it('all recipes have valid reporting formats', () => {
    for (const [, recipe] of builtInRecipesByName) {
      expect(['table', 'json', 'unified']).toContain(recipe.reporting.format);
    }
  });

  it('isBuiltInRecipe returns true for known recipes', () => {
    expect(isBuiltInRecipe('default')).toBe(true);
    expect(isBuiltInRecipe('security')).toBe(true);
    expect(isBuiltInRecipe('ci')).toBe(true);
  });

  it('isBuiltInRecipe returns false for unknown recipes', () => {
    expect(isBuiltInRecipe('nonexistent')).toBe(false);
    expect(isBuiltInRecipe('')).toBe(false);
  });

  it('recipes are frozen (immutable)', () => {
    for (const recipe of builtInRecipes) {
      expect(Object.isFrozen(recipe)).toBe(true);
    }
  });
});
