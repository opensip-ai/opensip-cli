import { describe, expect, it } from 'vitest';

import {
  clampLimit,
  isCapReason,
  makeFacet,
  mergeFacet,
  rollupFacets,
  UNREQUESTED_FACET,
  type CoverageFacetSet,
} from '../read/index.js';

const facets = (over: Partial<CoverageFacetSet> = {}): CoverageFacetSet => ({
  inventory: UNREQUESTED_FACET,
  evidence: UNREQUESTED_FACET,
  grouping: UNREQUESTED_FACET,
  projection: UNREQUESTED_FACET,
  ...over,
});

describe('clampLimit (canonical home — shared by graph read views + MCP pre-clamps)', () => {
  it('clamps limits to the inclusive 1..500 band, defaulting non-finite input', () => {
    expect(clampLimit(undefined, 25)).toBe(25);
    expect(clampLimit(Number.NaN, 10)).toBe(10);
    expect(clampLimit(Number.POSITIVE_INFINITY, 10)).toBe(10);
    expect(clampLimit(Number.NEGATIVE_INFINITY, 10)).toBe(10);
    expect(clampLimit(0, 10)).toBe(10);
    expect(clampLimit(-3, 10)).toBe(10);
    expect(clampLimit(3.9, 10)).toBe(3);
    expect(clampLimit(9999, 10)).toBe(500);
  });
});

describe('isCapReason (declared cap vocabulary + suffix defense-in-depth)', () => {
  it('classifies every registered cap code as truncating', () => {
    expect(isCapReason('group-key-cap')).toBe(true);
    expect(isCapReason('test-selection-depth-cap')).toBe(true);
  });

  it('keeps the -cap suffix convention for not-yet-registered codes', () => {
    expect(isCapReason('future-window-cap')).toBe(true);
  });

  it('never classifies an informational reason as truncating', () => {
    expect(isCapReason('malformed-symbol-omitted')).toBe(false);
    expect(isCapReason('capitalization')).toBe(false);
  });
});

describe('makeFacet (P2 Phase 2.1)', () => {
  it('is complete + untruncated with no reasons', () => {
    expect(makeFacet(true, new Set())).toEqual({
      requested: true,
      complete: true,
      truncated: false,
      reasons: [],
    });
  });

  it('marks truncation only for -cap reasons and sorts/dedupes reasons', () => {
    const facet = makeFacet(
      true,
      new Set(['malformed-omitted', 'proof-edge-cap', 'malformed-omitted']),
    );
    expect(facet.complete).toBe(false);
    expect(facet.truncated).toBe(true);
    expect(facet.reasons).toEqual(['malformed-omitted', 'proof-edge-cap']);
  });

  it('is incomplete but not truncated for a non-cap reason', () => {
    const facet = makeFacet(true, new Set(['fast-resolution-approximate']));
    expect(facet).toMatchObject({ complete: false, truncated: false });
  });
});

describe('mergeFacet (P2 Phase 2.1)', () => {
  it('unions reasons, ANDs complete, ORs truncated/requested', () => {
    const a = makeFacet(true, new Set(['a-cap']));
    const b = makeFacet(false, new Set(['b-omitted']));
    expect(mergeFacet(a, b)).toEqual({
      requested: true,
      complete: false,
      truncated: true,
      reasons: ['a-cap', 'b-omitted'],
    });
  });

  it('stays complete when both facets are complete', () => {
    expect(mergeFacet(makeFacet(true, new Set()), makeFacet(true, new Set())).complete).toBe(true);
  });
});

describe('rollupFacets (P2 Phase 2.1)', () => {
  it('summarizes only requested facets — a capped UNrequested sample is not truncation', () => {
    const coverage = rollupFacets(
      facets({
        inventory: makeFacet(true, new Set()),
        evidence: makeFacet(false, new Set(['call-evidence-cap'])),
      }),
    );
    expect(coverage.complete).toBe(true);
    expect(coverage.truncated).toBe(false);
    expect(coverage.reasons).toEqual([]);
    // The facet still records its own state for callers that inspect it.
    expect(coverage.evidence.truncated).toBe(true);
  });

  it('a requested capped sample DOES truncate the top-level summary', () => {
    const coverage = rollupFacets(
      facets({
        inventory: makeFacet(true, new Set()),
        evidence: makeFacet(true, new Set(['call-evidence-cap'])),
      }),
    );
    expect(coverage.complete).toBe(false);
    expect(coverage.truncated).toBe(true);
    expect(coverage.reasons).toEqual(['call-evidence-cap']);
  });

  it('keeps grouping independent of projection and unions requested reasons deterministically', () => {
    const coverage = rollupFacets(
      facets({
        inventory: makeFacet(true, new Set(['z-omitted'])),
        grouping: makeFacet(true, new Set(['group-key-cap'])),
        projection: makeFacet(true, new Set(['a-cap'])),
      }),
    );
    // Reasons across requested facets are unioned + code-point sorted.
    expect(coverage.reasons).toEqual(['a-cap', 'group-key-cap', 'z-omitted']);
    expect(coverage.truncated).toBe(true);
    expect(coverage.grouping.reasons).toEqual(['group-key-cap']);
    expect(coverage.projection.reasons).toEqual(['a-cap']);
  });

  it('is fully complete when no facet is requested', () => {
    const coverage = rollupFacets(facets());
    expect(coverage).toMatchObject({ complete: true, truncated: false, reasons: [] });
  });
});
