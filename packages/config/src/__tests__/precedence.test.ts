import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { resolveConfig } from '../precedence.js';

import type { ToolConfigDeclaration } from '../declaration.js';

const fitnessDecl: ToolConfigDeclaration = {
  namespace: 'fitness',
  schema: z.object({}),
  defaults: { failOnErrors: 1, failOnWarnings: 0, recipe: 'default' },
  env: [
    { envVar: 'OPENSIP_FIT_FAIL_ON_ERRORS', key: 'failOnErrors', type: 'number' },
    { envVar: 'OPENSIP_FIT_RECIPE', key: 'recipe' },
  ],
};

const graphDecl: ToolConfigDeclaration = {
  namespace: 'graph',
  schema: z.object({}),
  defaults: { cycleMinSize: 2 },
  env: [{ envVar: 'OPENSIP_GRAPH_STRICT', key: 'strict', type: 'boolean' }],
};

describe('resolveConfig precedence', () => {
  it('returns defaults when no other source supplies a key', () => {
    const resolved = resolveConfig({ declarations: [fitnessDecl] });
    expect(resolved.fitness).toEqual({ failOnErrors: 1, failOnWarnings: 0, recipe: 'default' });
  });

  it('file overrides defaults', () => {
    const resolved = resolveConfig({
      declarations: [fitnessDecl],
      file: { fitness: { failOnErrors: 5 } },
    });
    // file wins on failOnErrors; defaults preserved for the untouched keys.
    expect(resolved.fitness).toEqual({ failOnErrors: 5, failOnWarnings: 0, recipe: 'default' });
  });

  it('env overrides file overrides defaults', () => {
    const resolved = resolveConfig({
      declarations: [fitnessDecl],
      file: { fitness: { failOnErrors: 5, recipe: 'fromFile' } },
      env: { OPENSIP_FIT_FAIL_ON_ERRORS: '9' },
    });
    expect(resolved.fitness.failOnErrors).toBe(9); // env wins
    expect(resolved.fitness.recipe).toBe('fromFile'); // env didn't set recipe → file wins
  });

  it('flag overrides env overrides file overrides default', () => {
    const resolved = resolveConfig({
      declarations: [fitnessDecl],
      file: { fitness: { failOnErrors: 5 } },
      env: { OPENSIP_FIT_FAIL_ON_ERRORS: '9' },
      flags: { fitness: { failOnErrors: 42 } },
    });
    expect(resolved.fitness.failOnErrors).toBe(42); // flag wins over all
  });

  it('resolves per-key, not per-namespace (a flag does not clobber sibling keys)', () => {
    const resolved = resolveConfig({
      declarations: [fitnessDecl],
      file: { fitness: { failOnErrors: 7 } },
      flags: { fitness: { recipe: 'strict' } },
    });
    expect(resolved.fitness).toEqual({
      failOnErrors: 7, // from file, untouched by the flag
      failOnWarnings: 0, // from defaults
      recipe: 'strict', // from flag
    });
  });

  it('coerces env bindings by type (number)', () => {
    const resolved = resolveConfig({
      declarations: [fitnessDecl],
      env: { OPENSIP_FIT_FAIL_ON_ERRORS: '3' },
    });
    expect(resolved.fitness.failOnErrors).toBe(3);
    expect(typeof resolved.fitness.failOnErrors).toBe('number');
  });

  it('coerces env bindings by type (boolean true/false/1/0)', () => {
    expect(
      resolveConfig({ declarations: [graphDecl], env: { OPENSIP_GRAPH_STRICT: 'TRUE' } }).graph
        .strict,
    ).toBe(true);
    expect(
      resolveConfig({ declarations: [graphDecl], env: { OPENSIP_GRAPH_STRICT: '0' } }).graph.strict,
    ).toBe(false);
    expect(
      resolveConfig({ declarations: [graphDecl], env: { OPENSIP_GRAPH_STRICT: 'false' } }).graph
        .strict,
    ).toBe(false);
    expect(
      resolveConfig({ declarations: [graphDecl], env: { OPENSIP_GRAPH_STRICT: '1' } }).graph.strict,
    ).toBe(true);
  });

  it('drops an env value that fails coercion (non-numeric number, non-bool boolean)', () => {
    const numResolved = resolveConfig({
      declarations: [fitnessDecl],
      env: { OPENSIP_FIT_FAIL_ON_ERRORS: 'not-a-number' },
    });
    // coercion failed → falls back to default
    expect(numResolved.fitness.failOnErrors).toBe(1);

    const boolResolved = resolveConfig({
      declarations: [graphDecl],
      env: { OPENSIP_GRAPH_STRICT: 'maybe' },
    });
    expect(boolResolved.graph).not.toHaveProperty('strict');
  });

  it('passes string env values through verbatim (default type)', () => {
    const resolved = resolveConfig({
      declarations: [fitnessDecl],
      env: { OPENSIP_FIT_RECIPE: 'ci' },
    });
    expect(resolved.fitness.recipe).toBe('ci');
  });

  it('ignores an env var that is not present', () => {
    const resolved = resolveConfig({ declarations: [fitnessDecl], env: {} });
    expect(resolved.fitness.recipe).toBe('default'); // unset env → default
  });

  it('resolves multiple namespaces independently', () => {
    const resolved = resolveConfig({
      declarations: [fitnessDecl, graphDecl],
      flags: { fitness: { recipe: 'x' } },
    });
    expect(resolved.fitness.recipe).toBe('x');
    expect(resolved.graph).toEqual({ cycleMinSize: 2 });
  });

  it('handles a declaration with no defaults and no env bindings', () => {
    const bare: ToolConfigDeclaration = { namespace: 'sim', schema: z.object({}) };
    const resolved = resolveConfig({
      declarations: [bare],
      file: { sim: { recipe: 'demo' } },
    });
    expect(resolved.sim).toEqual({ recipe: 'demo' });
  });

  it('ignores non-object defaults/file/flags blocks', () => {
    const oddDecl: ToolConfigDeclaration = {
      namespace: 'odd',
      schema: z.object({}),
      defaults: 'not-an-object',
    };
    const resolved = resolveConfig({
      declarations: [oddDecl],
      file: { odd: ['array', 'not', 'object'] as unknown as Record<string, unknown> },
      flags: { odd: null as unknown as Record<string, unknown> },
    });
    expect(resolved.odd).toEqual({});
  });
});
