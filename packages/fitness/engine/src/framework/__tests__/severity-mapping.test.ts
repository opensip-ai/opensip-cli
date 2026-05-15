import { describe, expect, it } from 'vitest';

import { mapFindingSeverity, mapTagsToSignalCategory } from '../severity-mapping.js';

describe('mapFindingSeverity', () => {
  it('maps "error" to "high"', () => {
    expect(mapFindingSeverity('error')).toBe('high');
  });

  it('maps "warning" to "medium"', () => {
    expect(mapFindingSeverity('warning')).toBe('medium');
  });

  it('falls back to "medium" for unknown severities', () => {
    // @ts-expect-error — exercising the runtime default
    expect(mapFindingSeverity('whatever')).toBe('medium');
  });
});

describe('mapTagsToSignalCategory', () => {
  it.each([
    ['security', 'security'],
    ['performance', 'performance'],
    ['architecture', 'architecture'],
    ['resilience', 'resilience'],
    ['testing', 'testing'],
    ['documentation', 'documentation'],
  ])('maps %s tag to %s category', (tag, category) => {
    expect(mapTagsToSignalCategory([tag])).toBe(category);
  });

  it('maps "quality" tag to "warning" category', () => {
    expect(mapTagsToSignalCategory(['quality'])).toBe('warning');
  });

  it('falls back to "warning" when no recognized tag matches', () => {
    expect(mapTagsToSignalCategory(['custom-tag'])).toBe('warning');
  });

  it('returns "warning" for an empty tag list', () => {
    expect(mapTagsToSignalCategory([])).toBe('warning');
  });

  it('uses the first matching tag (priority order)', () => {
    // 'quality' comes after 'security' lexically but the function iterates the
    // input array in order, so 'security' wins here.
    expect(mapTagsToSignalCategory(['quality', 'security'])).toBe('warning');
    expect(mapTagsToSignalCategory(['security', 'quality'])).toBe('security');
  });
});
