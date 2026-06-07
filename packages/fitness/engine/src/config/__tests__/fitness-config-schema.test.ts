/**
 * Unit coverage for the fitness namespace config schema (Phase 4 Task 4.2).
 * The schema validates the `fitness:` block; the composer adds `.strict()`.
 */

import { describe, expect, it } from 'vitest';

import { FitnessNamespaceSchema, fitnessConfigDeclaration } from '../fitness-config-schema.js';

describe('FitnessNamespaceSchema', () => {
  it('accepts a well-formed fitness block', () => {
    const parsed = FitnessNamespaceSchema.parse({
      failOnErrors: 1,
      failOnWarnings: 0,
      disabledChecks: ['some-check'],
      recipe: 'backend',
    });
    expect(parsed.failOnErrors).toBe(1);
    expect(parsed.disabledChecks).toEqual(['some-check']);
    expect(parsed.recipe).toBe('backend');
  });

  it('accepts an empty block (all knobs optional)', () => {
    expect(FitnessNamespaceSchema.parse({})).toEqual({});
  });

  it('rejects a negative failOnErrors', () => {
    expect(FitnessNamespaceSchema.safeParse({ failOnErrors: -1 }).success).toBe(false);
  });

  it('rejects a non-string disabledChecks entry', () => {
    expect(FitnessNamespaceSchema.safeParse({ disabledChecks: [3] }).success).toBe(false);
  });

  it('rejects an unknown key once strict (composer behaviour)', () => {
    const strict = FitnessNamespaceSchema.strict();
    expect(strict.safeParse({ faliOnErrors: 1 }).success).toBe(false);
  });

  it('declares namespace fitness with the historical defaults', () => {
    expect(fitnessConfigDeclaration.namespace).toBe('fitness');
    expect(fitnessConfigDeclaration.defaults).toEqual({
      failOnErrors: 1,
      failOnWarnings: 0,
      disabledChecks: [],
    });
  });
});
