/**
 * analyzeNamespaceClaims (ADR-0043, plan phase 7.4): the pure claim report —
 * unclaimed keys named; did-you-mean within edit distance ≤2; claimed keys and
 * non-object documents silent.
 */

import { z } from 'zod';
import { describe, expect, it } from 'vitest';

import { analyzeNamespaceClaims } from '../namespace-claims.js';

import type { ToolConfigDeclaration } from '../declaration.js';

const decl = (namespace: string): ToolConfigDeclaration => ({
  namespace,
  schema: z.object({}).optional(),
});

const DECLS = [decl('fitness'), decl('graph'), decl('cli'), decl('targets')];

describe('analyzeNamespaceClaims', () => {
  it('reports nothing when every key is claimed', () => {
    expect(
      analyzeNamespaceClaims(DECLS, { fitness: {}, graph: {}, targets: {} }).unclaimed,
    ).toEqual([]);
  });

  it('names an unclaimed namespace with a did-you-mean when close', () => {
    const report = analyzeNamespaceClaims(DECLS, { fitnes: { recipe: 'x' } });
    expect(report.unclaimed).toEqual([{ namespace: 'fitnes', suggestion: 'fitness' }]);
  });

  it('suggests across a transposition (edit distance 2)', () => {
    const report = analyzeNamespaceClaims(DECLS, { grpah: {} });
    expect(report.unclaimed[0]?.suggestion).toBe('graph');
  });

  it('omits the suggestion when nothing is close', () => {
    const report = analyzeNamespaceClaims(DECLS, { 'acme-audit': {} });
    expect(report.unclaimed).toEqual([{ namespace: 'acme-audit' }]);
  });

  it('handles non-object documents without reporting', () => {
    expect(analyzeNamespaceClaims(DECLS, undefined).unclaimed).toEqual([]);
    expect(analyzeNamespaceClaims(DECLS, 'nonsense').unclaimed).toEqual([]);
    expect(analyzeNamespaceClaims(DECLS, [1, 2]).unclaimed).toEqual([]);
  });
});
