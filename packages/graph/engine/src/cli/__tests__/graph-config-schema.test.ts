/**
 * Unit coverage for the graph namespace config schema (Phase 4 Task 4.1) —
 * parity with the fitness/simulation `*-config-schema` tests. The schema
 * validates the `graph:` block; the composer adds `.strict()`.
 */

import { describe, expect, it } from 'vitest';

import { GraphConfigSchema, graphConfigDeclaration } from '../graph-config-schema.js';

describe('GraphConfigSchema', () => {
  it('accepts a well-formed graph block', () => {
    const parsed = GraphConfigSchema.parse({
      minCrossPackageDuplicatePackages: 2,
      cycleMinSize: 3,
      cycleSize2Severity: 'low',
      recipe: 'default',
      entryPointHashes: ['abc'],
      severityOverrides: { 'graph:orphan-subtree': 'error' },
    });
    expect(parsed.minCrossPackageDuplicatePackages).toBe(2);
    expect(parsed.cycleSize2Severity).toBe('low');
    expect(parsed.severityOverrides).toEqual({ 'graph:orphan-subtree': 'error' });
  });

  it('accepts an empty block (every knob optional → in-rule default)', () => {
    expect(GraphConfigSchema.parse({})).toEqual({});
  });

  it('rejects a negative numeric knob', () => {
    expect(GraphConfigSchema.safeParse({ cycleMinSize: -1 }).success).toBe(false);
  });

  it('rejects an out-of-enum severityOverrides value', () => {
    expect(
      GraphConfigSchema.safeParse({ severityOverrides: { 'graph:x': 'nonsense' } }).success,
    ).toBe(false);
  });

  it('rejects an out-of-enum cycleSize2Severity value', () => {
    expect(GraphConfigSchema.safeParse({ cycleSize2Severity: 'high' }).success).toBe(false);
  });

  it('accepts a valid partitionStrategy value', () => {
    expect(GraphConfigSchema.parse({ partitionStrategy: 'directory-depth' })).toEqual({
      partitionStrategy: 'directory-depth',
    });
  });

  it('rejects an out-of-enum partitionStrategy value', () => {
    expect(GraphConfigSchema.safeParse({ partitionStrategy: 'comunity' }).success).toBe(false);
  });

  it('rejects a typo of the partitionStrategy key once strict (composer behaviour)', () => {
    expect(GraphConfigSchema.strict().safeParse({ partitionStratgy: 'hybrid' }).success).toBe(
      false,
    );
  });

  it('rejects an unknown key once strict (composer behaviour)', () => {
    // The historical typo the strict schema now catches instead of dropping.
    expect(
      GraphConfigSchema.strict().safeParse({ minCrossPackageDuplicatePackges: 2 }).success,
    ).toBe(false);
  });

  it('declares namespace graph with no defaults (knobs default in-rule)', () => {
    expect(graphConfigDeclaration.namespace).toBe('graph');
    expect(graphConfigDeclaration.defaults).toBeUndefined();
    expect(graphConfigDeclaration.schema).toBe(GraphConfigSchema);
  });

  it('declares exactly the partitionStrategy env binding', () => {
    expect(graphConfigDeclaration.env).toEqual([
      { envVar: 'OPENSIP_GRAPH_PARTITION_STRATEGY', key: 'partitionStrategy' },
    ]);
  });
});
