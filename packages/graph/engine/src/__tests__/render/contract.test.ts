/**
 * Renderer contract conformance (PR-3).
 *
 * This is a compile-time test seam. If any renderer drifts from the
 * Renderer signature alias, this file fails to typecheck.
 */

import { describe, expect, it } from 'vitest';

import { renderTable } from '../../render/table.js';

import type { Renderer } from '../../render/types.js';

// Post-ADR-0011 (Phase 5) the json/sarif renderers moved out (json → the
// shared `formatSignalJson` via `cli.emitEnvelope`; sarif → the root's
// `cli.writeSarif` / `--report-to`). `renderTable` is the remaining
// Renderer-shaped helper; this seam keeps its signature drift-checked.
const _table: Renderer = renderTable;

describe('Renderer contract conformance (PR-3)', () => {
  it('compile-time references are present', () => {
    // The compile-time check is that the const above type-checks.
    expect(typeof _table).toBe('function');
  });
});
