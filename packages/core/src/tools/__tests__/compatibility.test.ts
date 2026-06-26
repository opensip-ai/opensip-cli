/**
 * Tests for the pure compatibility gate (release 2.8.0, Phase 0).
 */

import { describe, expect, it } from 'vitest';

import { checkCompatibility } from '../compatibility.js';
import { MIN_SUPPORTED_PLUGIN_API_VERSION, PLUGIN_API_VERSION } from '../manifest.js';

describe('checkCompatibility', () => {
  it('admits a tool declaring the current epoch', () => {
    expect(checkCompatibility(PLUGIN_API_VERSION)).toEqual({ kind: 'compatible' });
  });

  it('admits a tool declaring the minimum supported epoch', () => {
    expect(checkCompatibility(MIN_SUPPORTED_PLUGIN_API_VERSION)).toEqual({ kind: 'compatible' });
  });

  it('admits a middle epoch when the supported range spans multiple epochs', () => {
    expect(checkCompatibility(2, { minSupported: 1, current: 3 })).toEqual({ kind: 'compatible' });
  });

  it('rejects a tool with no declared apiVersion (3.0.0 — grace window ended)', () => {
    const verdict = checkCompatibility(undefined);
    expect(verdict.kind).toBe('incompatible');
    if (verdict.kind === 'incompatible') {
      expect(verdict.reason).toContain('no plugin apiVersion');
      expect(verdict.minSupported).toBe(MIN_SUPPORTED_PLUGIN_API_VERSION);
      expect(verdict.engine).toBe(PLUGIN_API_VERSION);
    }
  });

  it('rejects a future epoch with the declared + engine integers and a reason', () => {
    const verdict = checkCompatibility(PLUGIN_API_VERSION + 1);
    expect(verdict.kind).toBe('incompatible');
    if (verdict.kind === 'incompatible') {
      expect(verdict.declared).toBe(PLUGIN_API_VERSION + 1);
      expect(verdict.minSupported).toBe(MIN_SUPPORTED_PLUGIN_API_VERSION);
      expect(verdict.engine).toBe(PLUGIN_API_VERSION);
      expect(verdict.reason).toMatch(/upgrade OpenSIP CLI/i);
    }
  });

  it('rejects a past epoch below the minimum supported with a tool-upgrade reason', () => {
    const verdict = checkCompatibility(0, { minSupported: 1, current: 2 });
    expect(verdict.kind).toBe('incompatible');
    if (verdict.kind === 'incompatible') {
      expect(verdict.declared).toBe(0);
      expect(verdict.minSupported).toBe(1);
      expect(verdict.engine).toBe(2);
      expect(verdict.reason).toMatch(/upgrade the tool/i);
      expect(verdict.reason).toContain('v1..v2');
    }
  });

  it('rejects a misconfigured engine range', () => {
    const verdict = checkCompatibility(1, { minSupported: 3, current: 1 });
    expect(verdict.kind).toBe('incompatible');
    if (verdict.kind === 'incompatible') {
      expect(verdict.reason).toMatch(/misconfigured/i);
    }
  });

  it('honours an explicit range override', () => {
    expect(checkCompatibility(2, { minSupported: 2, current: 2 })).toEqual({ kind: 'compatible' });
    expect(checkCompatibility(1, { minSupported: 2, current: 2 }).kind).toBe('incompatible');
  });
});
