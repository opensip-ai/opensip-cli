import { logger } from '@opensip-tools/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

describe('mapTagsToSignalCategory — warn-once on unknown tags', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('warns when a check\'s tags include none of the known categories', () => {
    // Use a tag-set we have not seen before so the dedupe cache misses.
    expect(mapTagsToSignalCategory(['custom-foo-misspelled'])).toBe('warning');
    expect(warnSpy).toHaveBeenCalled();
    const call = warnSpy.mock.calls[0]?.[0] as { evt?: string; tags?: string[] } | undefined;
    expect(call?.evt).toBe('fitness.severity_mapping.unknown_tags');
    expect(call?.tags).toEqual(['custom-foo-misspelled']);
  });

  it('warns only once for the same unknown tag-set', () => {
    mapTagsToSignalCategory(['warn-once-fixture-tag']);
    mapTagsToSignalCategory(['warn-once-fixture-tag']);
    mapTagsToSignalCategory(['warn-once-fixture-tag']);
    const matching = warnSpy.mock.calls.filter((c) => {
      const arg = c[0] as { tags?: string[] } | undefined;
      return arg?.tags?.[0] === 'warn-once-fixture-tag';
    });
    expect(matching.length).toBe(1);
  });

  it('does not warn when at least one known tag is present', () => {
    mapTagsToSignalCategory(['security', 'totally-unknown']);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
