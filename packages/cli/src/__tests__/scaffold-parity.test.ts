/**
 * TEMPORARY Phase-1 parity test (ADR-0038): asserts the relocated tool-owned
 * scaffold builders (`fitnessTool.scaffoldExamples` / `simulationTool.
 * scaffoldExamples`) produce BYTE-IDENTICAL output to the legacy CLI-owned
 * builders in `config-templates.ts`. Phase 2 re-points the real `init` consumer
 * onto the tool hooks (the golden then guards byte-identity), and this interim
 * test is deleted.
 */

import { fitnessTool } from '@opensip-tools/fitness';
import { simulationTool } from '@opensip-tools/simulation';
import { describe, expect, it } from 'vitest';

import {
  exampleCheckSource,
  exampleRecipeSource,
  exampleScenarioSource,
  exampleSimRecipeSource,
} from '../commands/init/config-templates.js';

import type { ScaffoldFile } from '@opensip-tools/core';

function byFilename(files: readonly ScaffoldFile[], name: string): ScaffoldFile {
  const f = files.find((x) => x.filename === name);
  if (!f) throw new Error(`no scaffold file '${name}'`);
  return f;
}

describe('Phase-1 scaffold parity (tool hook == legacy CLI builder)', () => {
  it('fit single-language check + recipe bytes match the legacy builders', () => {
    const files = fitnessTool.scaffoldExamples?.({ languages: ['typescript'] }) ?? [];
    expect(byFilename(files, 'example-check.mjs').content).toBe(exampleCheckSource('typescript'));
    expect(byFilename(files, 'example-recipe.mjs').content).toBe(
      exampleRecipeSource(['example-check']),
    );
  });

  it('fit polyglot per-language checks + recipe slug list match the legacy builders', () => {
    const files = fitnessTool.scaffoldExamples?.({ languages: ['rust', 'typescript'] }) ?? [];
    expect(byFilename(files, 'example-check-rust.mjs').content).toBe(
      exampleCheckSource('rust', 'rust'),
    );
    expect(byFilename(files, 'example-check-typescript.mjs').content).toBe(
      exampleCheckSource('typescript', 'typescript'),
    );
    expect(byFilename(files, 'example-recipe.mjs').content).toBe(
      exampleRecipeSource(['example-check-rust', 'example-check-typescript']),
    );
  });

  it('sim scenario + recipe bytes match the legacy builders', () => {
    const files = simulationTool.scaffoldExamples?.({ languages: ['typescript'] }) ?? [];
    expect(byFilename(files, 'example-scenario.mjs').content).toBe(exampleScenarioSource());
    expect(byFilename(files, 'example-recipe.mjs').content).toBe(exampleSimRecipeSource());
  });

  it('the tools expose their complete stable-id universe', () => {
    expect(fitnessTool.stableExampleIds?.()).toHaveLength(6); // 6 languages
    expect(simulationTool.stableExampleIds?.()).toEqual(['example-scenario', 'URCP_sim_example']);
  });
});
