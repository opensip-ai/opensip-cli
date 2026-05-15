import { describe, expect, it } from 'vitest';

import { FitnessRecipeRegistry } from '../registry.js';

import type { FitnessRecipe } from '../types.js';

const stub = (id: string, name: string, tags: string[] = []): FitnessRecipe => ({
  id,
  name,
  displayName: name,
  description: name,
  tags,
  checks: { type: 'all', exclude: [] },
  execution: { mode: 'parallel', stopOnFirstFailure: false, timeout: 30_000 },
  reporting: { format: 'table', verbose: false },
});

describe('FitnessRecipeRegistry', () => {
  it('pre-loads built-in recipes by default', () => {
    const reg = new FitnessRecipeRegistry({ logWarnings: false });
    expect(reg.size).toBeGreaterThan(0);
    expect(reg.has('default')).toBe(true);
  });

  it('loadRecipe finds by name or id', () => {
    const reg = new FitnessRecipeRegistry({ logWarnings: false });
    expect(reg.loadRecipe('default')).toBeDefined();
    expect(reg.loadRecipe('nope')).toBeUndefined();
  });

  it('getByName / getById work independently', () => {
    const reg = new FitnessRecipeRegistry({ logWarnings: false });
    const def = reg.getByName('default');
    expect(def).toBeDefined();
    expect(reg.getById(def?.id ?? '')).toBe(def);
    expect(reg.getById('NOT_EXIST')).toBeUndefined();
  });

  it('register refuses to overwrite by default', () => {
    const reg = new FitnessRecipeRegistry({ loadUserRecipes: false, logWarnings: false });
    reg.register(stub('URCP_a', 'a'));
    expect(() => reg.register(stub('URCP_a', 'a'))).toThrow(/already registered/);
  });

  it('register allows overwrite when explicitly requested', () => {
    const reg = new FitnessRecipeRegistry({ loadUserRecipes: false, logWarnings: false });
    reg.register(stub('URCP_a', 'a'));
    reg.register({ ...stub('URCP_a', 'a'), description: 'updated' }, { allowOverwrite: true });
    expect(reg.getByName('a')?.description).toBe('updated');
  });

  it('registerAll mounts every recipe in a list', () => {
    const reg = new FitnessRecipeRegistry({ loadUserRecipes: false, logWarnings: false });
    reg.clear();
    reg.registerAll([stub('URCP_a', 'a'), stub('URCP_b', 'b')]);
    expect(reg.size).toBe(2);
  });

  it('remove returns true on hit, false on miss', () => {
    const reg = new FitnessRecipeRegistry({ loadUserRecipes: false, logWarnings: false });
    reg.register(stub('URCP_a', 'a'));
    expect(reg.remove('URCP_a')).toBe(true);
    expect(reg.remove('URCP_a')).toBe(false);
  });

  it('reset clears user-registered and restores built-ins', () => {
    const reg = new FitnessRecipeRegistry({ loadUserRecipes: false, logWarnings: false });
    reg.register(stub('URCP_user', 'user'));
    reg.reset();
    expect(reg.has('user')).toBe(false);
    expect(reg.has('default')).toBe(true);
  });

  it('getByTag returns matching recipes', () => {
    const reg = new FitnessRecipeRegistry({ loadUserRecipes: false, logWarnings: false });
    reg.register(stub('URCP_t1', 't1', ['custom-tag-xyz']));
    reg.register(stub('URCP_t2', 't2', ['other-tag']));
    expect(reg.getByTag('custom-tag-xyz').map((r) => r.name)).toEqual(['t1']);
  });

  it('getNames returns all registered names', () => {
    const reg = new FitnessRecipeRegistry({ loadUserRecipes: false, logWarnings: false });
    expect(reg.getNames()).toContain('default');
  });

  it('listForDisplay distinguishes built-in vs user-defined', () => {
    const reg = new FitnessRecipeRegistry({ loadUserRecipes: false, logWarnings: false });
    reg.register(stub('URCP_user', 'user'));
    const display = reg.listForDisplay();
    expect(display.find((d) => d.name === 'default')?.isBuiltIn).toBe(true);
    expect(display.find((d) => d.name === 'user')?.isUserDefined).toBe(true);
  });

  it('isOverridden / getOverriddenBuiltIns reflect override state', () => {
    const reg = new FitnessRecipeRegistry({ loadUserRecipes: false, logWarnings: false });
    expect(reg.isOverridden('default')).toBe(false);
    expect(reg.getOverriddenBuiltIns()).toEqual([]);
  });

  it('getUserRecipesLoadResult is defined when loadUserRecipes runs', () => {
    const reg = new FitnessRecipeRegistry({ logWarnings: false });
    expect(reg.getUserRecipesLoadResult()).toBeDefined();
  });

  it('getUserRecipesLoadResult is undefined when loadUserRecipes is disabled', () => {
    const reg = new FitnessRecipeRegistry({ loadUserRecipes: false, logWarnings: false });
    expect(reg.getUserRecipesLoadResult()).toBeUndefined();
  });

  it('clear removes everything', () => {
    const reg = new FitnessRecipeRegistry({ loadUserRecipes: false, logWarnings: false });
    reg.clear();
    expect(reg.size).toBe(0);
  });
});
