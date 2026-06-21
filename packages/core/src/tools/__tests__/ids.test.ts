/**
 * Tests for the canonical tool-id registry (audit-round-3 Finding H) and the
 * M3 open-discriminant widening (BundledToolShortId + registry-validated guards).
 */

import { describe, expect, it } from 'vitest';

import {
  TOOL_LONG_IDS,
  TOOL_LONG_TO_SHORT,
  TOOL_SHORT_IDS,
  TOOL_SHORT_TO_LONG,
  isBundledToolShortId,
  isToolLongId,
  isToolShortId,
} from '../ids.js';
import { isRegisteredToolId, registeredToolShortIds } from '../registered-ids.js';
import { ToolRegistry } from '../registry.js';

import type { Tool } from '../types.js';

/** A minimal Tool whose session short id == its command verb (the fit/sim/graph shape). */
const tool = (name: string): Tool => ({
  metadata: {
    id: '00000000-0000-4000-8000-000000000000',
    name,
    version: '0.0.0',
    description: `${name} stub`,
  },
  commands: [{ name, description: `${name} command` }],
});

/** A Tool that persists/replays under an explicit `sessionReplay.tool` short id. */
const toolWithReplay = (name: string, replayTool: string): Tool => ({
  ...tool(name),
  extensionPoints: {
    sessionReplay: { tool: replayTool, replaySession: () => ({}) },
  },
});

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

  // The BUNDLED guard — closed-set membership for the first-party three (keys of
  // the long/short maps). Unchanged semantics; renamed from the old isToolShortId.
  describe('isBundledToolShortId', () => {
    it.each(TOOL_SHORT_IDS)('accepts %s', (id) => {
      expect(isBundledToolShortId(id)).toBe(true);
    });

    it('rejects non-bundled ids', () => {
      expect(isBundledToolShortId('fitness')).toBe(false); // long form
      expect(isBundledToolShortId('audit')).toBe(false); // third-party
      expect(isBundledToolShortId('')).toBe(false);
    });

    it('rejects non-strings', () => {
      expect(isBundledToolShortId(undefined)).toBe(false);
      expect(isBundledToolShortId(null)).toBe(false);
      expect(isBundledToolShortId(123)).toBe(false);
      expect(isBundledToolShortId({})).toBe(false);
    });
  });

  // The OPEN structural guard — the storage discriminant boundary (M3). Asserts
  // SHAPE only (non-empty string), NOT membership: a third-party id is valid so
  // its session rows hydrate. This is the datastore-layer guard.
  describe('isToolShortId (open structural)', () => {
    it.each([...TOOL_SHORT_IDS, 'audit', 'my-tool', 'fitness'])('accepts %s', (id) => {
      expect(isToolShortId(id)).toBe(true);
    });

    it('rejects empty / non-string values', () => {
      expect(isToolShortId('')).toBe(false);
      expect(isToolShortId(undefined)).toBe(false);
      expect(isToolShortId(null)).toBe(false);
      expect(isToolShortId(123)).toBe(false);
      expect(isToolShortId({})).toBe(false);
    });
  });

  // The registry-validated guard — membership against the LIVE tool registry.
  describe('isRegisteredToolId', () => {
    it('accepts a registered third-party tool id (session parity, M3)', () => {
      const reg = new ToolRegistry();
      reg.register(tool('audit'));
      expect(isRegisteredToolId('audit', reg)).toBe(true);
    });

    it('accepts a tool registered under an explicit sessionReplay.tool', () => {
      const reg = new ToolRegistry();
      reg.register(toolWithReplay('fitness', 'fit'));
      expect(isRegisteredToolId('fit', reg)).toBe(true); // replay short id
      expect(isRegisteredToolId('fitness', reg)).toBe(true); // command verb
    });

    it('rejects an unregistered id', () => {
      const reg = new ToolRegistry();
      reg.register(tool('fit'));
      expect(isRegisteredToolId('audit', reg)).toBe(false);
    });

    it('rejects empty / non-string values', () => {
      const reg = new ToolRegistry();
      reg.register(tool('fit'));
      expect(isRegisteredToolId('', reg)).toBe(false);
      expect(isRegisteredToolId(undefined, reg)).toBe(false);
      expect(isRegisteredToolId(123, reg)).toBe(false);
    });
  });

  describe('registeredToolShortIds', () => {
    it('collects each tool verb plus any explicit sessionReplay.tool', () => {
      const reg = new ToolRegistry();
      reg.register(toolWithReplay('fitness', 'fit'));
      reg.register(tool('graph'));
      reg.register(tool('audit'));
      expect(registeredToolShortIds(reg)).toEqual(new Set(['fitness', 'fit', 'graph', 'audit']));
    });

    it('is empty for an empty registry', () => {
      expect(registeredToolShortIds(new ToolRegistry()).size).toBe(0);
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
