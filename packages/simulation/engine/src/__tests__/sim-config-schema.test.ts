/**
 * Unit coverage for the simulation namespace config schema (Phase 4 Task 4.2).
 */

import { describe, expect, it } from 'vitest';

import { SimulationNamespaceSchema, simulationConfigDeclaration } from '../cli/sim-config-schema.js';

describe('SimulationNamespaceSchema', () => {
  it('accepts a block with a recipe', () => {
    expect(SimulationNamespaceSchema.parse({ recipe: 'example' })).toEqual({ recipe: 'example' });
  });

  it('accepts an empty block', () => {
    expect(SimulationNamespaceSchema.parse({})).toEqual({});
  });

  it('rejects a non-string recipe', () => {
    expect(SimulationNamespaceSchema.safeParse({ recipe: 3 }).success).toBe(false);
  });

  it('rejects an unknown key once strict (composer behaviour)', () => {
    expect(SimulationNamespaceSchema.strict().safeParse({ recpe: 'x' }).success).toBe(false);
  });

  it('declares namespace simulation', () => {
    expect(simulationConfigDeclaration.namespace).toBe('simulation');
  });
});
