/**
 * @fileoverview core→contracts re-export completeness (plan 09 Task 7.4).
 *
 * `contracts` is the public Tool↔runner facade and re-exports curated blocks
 * of the core-defined contract surface. Hand-maintained re-export lists
 * drift: a symbol added to core's surface but forgotten here silently
 * narrows the facade. This test makes the completeness MECHANICAL by
 * comparing the actual runtime exports of both barrels — chosen over a
 * dogfood fitness check because it compares semantics (real export
 * bindings), not file text, with zero cross-file path-gating machinery.
 * The decision and its alternative are recorded in the shared-analysis ADR.
 */

import { describe, expect, it } from 'vitest';

import * as contracts from './index.js';
import * as core from '@opensip-cli/core';

/**
 * The core export families contracts PROMISES to re-export completely.
 * Prefix-based so a new member of a promised family cannot be silently
 * forgotten; a genuinely new family is an explicit decision (add it here).
 */
const PROMISED_PREFIX_FAMILIES = [
  // Platform compatibility/LTS policy registry (the facade block at
  // contracts/src/index.ts › "Platform compatibility/LTS policy registry").
  /^COMPATIBILITY_/u,
  /_CONTRACT_VERSION$/u,
] as const;

/** Individually promised core symbols (the curated tool-contract block). */
const PROMISED_SYMBOLS = [
  'PLUGIN_API_VERSION',
  'checkCompatibility',
  'assertCompatibilityPoliciesComplete',
  'findCompatibilityPolicy',
] as const;

describe('contracts — core re-export completeness (Task 7.4)', () => {
  it('re-exports every member of the promised core export families', () => {
    const coreNames = Object.keys(core);
    const missing = coreNames.filter(
      (name) =>
        PROMISED_PREFIX_FAMILIES.some((family) => family.test(name)) && !(name in contracts),
    );
    expect(
      missing,
      `core exports missing from the contracts facade: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('re-exports each individually promised core symbol with the same binding', () => {
    for (const name of PROMISED_SYMBOLS) {
      expect(name in contracts, `contracts is missing '${name}'`).toBe(true);
      expect(
        (contracts as Record<string, unknown>)[name],
        `contracts '${name}' must be the SAME binding core exports (a re-export, not a fork)`,
      ).toBe((core as Record<string, unknown>)[name]);
    }
  });
});
