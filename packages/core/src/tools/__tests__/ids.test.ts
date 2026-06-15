/**
 * Tests for the canonical tool-id registry (audit-round-3 Finding H).
 */

import { describe, expect, it } from 'vitest';

import {
  TOOL_LONG_IDS,
  TOOL_LONG_TO_SHORT,
  TOOL_SHORT_IDS,
  TOOL_SHORT_TO_LONG,
  isToolLongId,
  isToolShortId,
} from '../ids.js';

describe('tool-id registry', () => {
  it('exposes both id lists', () => {
    expect([...TOOL_SHORT_IDS]).toEqual(['fit', 'sim', 'graph']);
    expect([...TOOL_LONG_IDS]).toEqual(['fitness', 'simulation', 'graph']);
  });

  it('long → short mapping is total and consistent', () => {
    expect(TOOL_LONG_TO_SHORT).toEqual({
      fitness: 'fit',
      simulation: 'sim',
      graph: 'graph',
    });
    for (const long of TOOL_LONG_IDS) {
      expect(TOOL_SHORT_IDS).toContain(TOOL_LONG_TO_SHORT[long]);
    }
  });

  it('short → long mapping is the inverse of long → short', () => {
    for (const short of TOOL_SHORT_IDS) {
      expect(TOOL_LONG_TO_SHORT[TOOL_SHORT_TO_LONG[short]]).toBe(short);
    }
    for (const long of TOOL_LONG_IDS) {
      expect(TOOL_SHORT_TO_LONG[TOOL_LONG_TO_SHORT[long]]).toBe(long);
    }
  });

  describe('isToolShortId', () => {
    it.each(TOOL_SHORT_IDS)('accepts %s', (id) => {
      expect(isToolShortId(id)).toBe(true);
    });

    it('rejects unknown short ids', () => {
      expect(isToolShortId('fitness')).toBe(false); // long form
      expect(isToolShortId('audit')).toBe(false);
      expect(isToolShortId('')).toBe(false);
    });

    it('rejects non-strings', () => {
      expect(isToolShortId(undefined)).toBe(false);
      expect(isToolShortId(null)).toBe(false);
      expect(isToolShortId(123)).toBe(false);
      expect(isToolShortId({})).toBe(false);
    });
  });

  describe('isToolLongId', () => {
    it.each(TOOL_LONG_IDS)('accepts %s', (id) => {
      expect(isToolLongId(id)).toBe(true);
    });

    it('rejects unknown long ids', () => {
      expect(isToolLongId('fit')).toBe(false); // short form
      expect(isToolLongId('audit')).toBe(false);
      expect(isToolLongId('')).toBe(false);
    });
  });
});
