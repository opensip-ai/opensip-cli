import { describe, expect, it } from 'vitest';

import { BUILTIN_DEFAULT_RECIPE, resolveToolRecipeName } from './recipe-default.js';

describe('resolveToolRecipeName (ADR-0022 precedence + tolerance)', () => {
  it('explicit --recipe wins over every config source and is strict', () => {
    expect(
      resolveToolRecipeName({
        explicit: 'backend',
        toolRecipe: 'graph-core',
        cliRecipe: 'opensip',
      }),
    ).toEqual({ name: 'backend', source: 'flag', tolerant: false, usedDeprecatedCliRecipe: false });
  });

  it('falls to <tool>.recipe when no flag, and is tolerant', () => {
    expect(resolveToolRecipeName({ toolRecipe: 'graph-core', cliRecipe: 'opensip' })).toEqual({
      name: 'graph-core',
      source: 'tool-config',
      tolerant: true,
      usedDeprecatedCliRecipe: false,
    });
  });

  it('falls to the deprecated cli.recipe last, flagging the fallback', () => {
    expect(resolveToolRecipeName({ cliRecipe: 'opensip' })).toEqual({
      name: 'opensip',
      source: 'cli-config',
      tolerant: true,
      usedDeprecatedCliRecipe: true,
    });
  });

  it('returns the builtin default when nothing is configured', () => {
    expect(resolveToolRecipeName({})).toEqual({
      name: BUILTIN_DEFAULT_RECIPE,
      source: 'builtin',
      tolerant: true,
      usedDeprecatedCliRecipe: false,
    });
  });

  it('treats empty-string config values as unset (precedence skips them)', () => {
    expect(resolveToolRecipeName({ explicit: '', toolRecipe: '', cliRecipe: 'opensip' })).toEqual({
      name: 'opensip',
      source: 'cli-config',
      tolerant: true,
      usedDeprecatedCliRecipe: true,
    });
  });
});
