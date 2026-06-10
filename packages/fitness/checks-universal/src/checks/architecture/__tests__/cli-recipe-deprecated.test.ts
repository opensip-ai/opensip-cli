import { describe, expect, it } from 'vitest';

import { analyzeCliRecipeDeprecated } from '../cli-recipe-deprecated.js';

const PATH = 'opensip-tools.config.yml';

describe('cli-recipe-deprecated (ADR-0022)', () => {
  it('flags a recipe key under the top-level cli: block', () => {
    const yaml = [
      'cli:',
      '  recipe: opensip',
      '  verbose: false',
      'fitness:',
      '  failOnErrors: 0',
    ].join('\n');
    const v = analyzeCliRecipeDeprecated(yaml, PATH);
    expect(v).toHaveLength(1);
    expect(v[0].line).toBe(2);
    expect(v[0].severity).toBe('warning');
    expect(v[0].message).toContain('cli.recipe');
  });

  it('does NOT flag recipe under fitness/graph/simulation (the correct tool-scoped form)', () => {
    const yaml = [
      'cli:',
      '  verbose: false',
      'fitness:',
      '  recipe: backend',
      'graph:',
      '  recipe: default',
      'simulation:',
      '  recipe: default',
    ].join('\n');
    expect(analyzeCliRecipeDeprecated(yaml, PATH)).toEqual([]);
  });

  it('does not flag when cli: block has no recipe', () => {
    const yaml = [
      'cli:',
      '  verbose: true',
      '  reportTo: https://x.example',
      'fitness:',
      '  recipe: ci',
    ].join('\n');
    expect(analyzeCliRecipeDeprecated(yaml, PATH)).toEqual([]);
  });

  it('is a no-op for any non-config file', () => {
    const yaml = ['cli:', '  recipe: opensip'].join('\n');
    expect(analyzeCliRecipeDeprecated(yaml, 'some/other/file.yml')).toEqual([]);
  });

  it('handles a comment after cli: and stops at the next top-level key', () => {
    // A recipe under a LATER top-level block must not be attributed to cli:.
    const yaml = ['cli: # defaults', '  verbose: false', 'fitness:', '  recipe: backend'].join(
      '\n',
    );
    expect(analyzeCliRecipeDeprecated(yaml, PATH)).toEqual([]);
  });
});
