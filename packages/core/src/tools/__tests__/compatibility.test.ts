/**
 * Tests for the pure compatibility gate (release 2.8.0, Phase 0).
 */

import { describe, expect, it } from 'vitest';

import { checkCompatibility } from '../compatibility.js';
import { PLUGIN_API_VERSION } from '../manifest.js';

describe('checkCompatibility', () => {
  it('admits a tool declaring the current epoch', () => {
    expect(checkCompatibility(PLUGIN_API_VERSION)).toEqual({ kind: 'compatible' });
  });

  it('admits a tool with no declared apiVersion (grace window)', () => {
    expect(checkCompatibility(undefined)).toEqual({ kind: 'compatible' });
  });

  it('rejects a future epoch with the declared + engine integers and a reason', () => {
    const verdict = checkCompatibility(PLUGIN_API_VERSION + 1);
    expect(verdict.kind).toBe('incompatible');
    if (verdict.kind === 'incompatible') {
      expect(verdict.declared).toBe(PLUGIN_API_VERSION + 1);
      expect(verdict.engine).toBe(PLUGIN_API_VERSION);
      expect(verdict.reason).toMatch(/upgrade opensip-tools/i);
    }
  });

  it('rejects a past epoch with a tool-upgrade reason', () => {
    const verdict = checkCompatibility(0, 1);
    expect(verdict.kind).toBe('incompatible');
    if (verdict.kind === 'incompatible') {
      expect(verdict.declared).toBe(0);
      expect(verdict.engine).toBe(1);
      expect(verdict.reason).toMatch(/upgrade the tool/i);
    }
  });

  it('honours an explicit engine override', () => {
    expect(checkCompatibility(2, 2)).toEqual({ kind: 'compatible' });
    expect(checkCompatibility(1, 2).kind).toBe('incompatible');
  });
});
