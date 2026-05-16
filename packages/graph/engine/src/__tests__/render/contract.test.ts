/**
 * Renderer contract conformance (PR-3).
 *
 * This is a compile-time test seam. If any renderer drifts from the
 * Renderer signature alias, this file fails to typecheck.
 */

import { describe, expect, it } from 'vitest';

import { renderJson } from '../../render/json.js';
import { renderTable } from '../../render/table.js';

import type { Renderer } from '../../render/types.js';

const _table: Renderer = renderTable;
const _json: Renderer = renderJson;
// renderSarif consumes a CliOutput, not Signal[] — by design (it's a
// thin wrapper around fitness's buildSarifLog) — so it does NOT
// implement the Renderer alias. This is documented in DEC-3.

describe('Renderer contract conformance (PR-3)', () => {
  it('compile-time references are present', () => {
    // The compile-time check is that the consts above type-check.
    expect(typeof _table).toBe('function');
    expect(typeof _json).toBe('function');
  });
});
