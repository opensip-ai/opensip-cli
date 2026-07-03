import { describe, expect, it } from 'vitest';

import { fitScaffoldConfigBlock } from './config-block.js';
import {
  EXAMPLE_CHECK_IDS,
  exampleCheckSource,
  exampleRecipeSource,
  fitScaffoldExamples,
  fitStableExampleIds,
} from './examples.js';

describe('fitness scaffold contributions', () => {
  it('renders the owned fitness config block with gate defaults', () => {
    expect(fitScaffoldConfigBlock()).toContain('fitness:');
    expect(fitScaffoldConfigBlock()).toContain('failOnErrors: 1');
    expect(fitScaffoldConfigBlock()).toContain('disabledChecks: []');
  });

  it('renders single-language example check and recipe files', () => {
    const files = fitScaffoldExamples({ languages: ['typescript'] });

    expect(files.map((file) => [file.kind, file.filename, file.stableId])).toEqual([
      ['checks', 'example-check.mjs', EXAMPLE_CHECK_IDS.typescript],
      ['recipes', 'example-recipe.mjs', 'URCP_example'],
    ]);
    expect(files[0]?.content).toContain("const CHECK_SLUG = 'example-check'");
    expect(files[0]?.content).not.toContain('@opensip-cli/fitness');
    expect(files[0]?.content).toContain(EXAMPLE_CHECK_IDS.typescript);
    expect(files[1]?.content).toContain("checkIds: ['example-check']");
  });

  it('renders polyglot example checks with language-specific slugs', () => {
    const files = fitScaffoldExamples({ languages: ['go', 'python'] });

    expect(files.map((file) => file.filename)).toEqual([
      'example-check-go.mjs',
      'example-check-python.mjs',
      'example-recipe.mjs',
    ]);
    expect(files[0]?.content).toContain("const CHECK_SLUG = 'example-check-go'");
    expect(files[1]?.content).toContain("const CHECK_SCOPE = { languages: ['python']");
    expect(files[2]?.content).toContain("checkIds: ['example-check-go', 'example-check-python']");
  });

  it('defaults unknown languages to an empty example id while keeping source valid', () => {
    expect(exampleCheckSource('unknown')).toContain("const CHECK_ID = ''");
    expect(exampleCheckSource('rust', 'rust')).toContain("const CHECK_SLUG = 'example-check-rust'");
    expect(exampleRecipeSource(['a', 'b'])).toContain("checkIds: ['a', 'b']");
    expect(fitStableExampleIds().sort()).toEqual(Object.values(EXAMPLE_CHECK_IDS).sort());
  });
});
