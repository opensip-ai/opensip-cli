/**
 * Export-surface lock for `@opensip-cli/graph/internal`.
 *
 * `/internal` is the deliberate, test-only escape hatch (ADR-0009): the
 * cross-package adapter + CLI-telemetry suites reach `runGraph`/`executeGraph`,
 * the raw rule instances, `buildIndexes`, the heap-preflight surface, and
 * `CatalogRepo` through it without going through Commander. Production code in
 * other packages must NOT import it (dependency-cruiser enforces that).
 *
 * This lock keeps the internal surface from growing silently — the 2026-06-05
 * boundary audit's concern that a test-only contract can quietly widen and slow
 * future refactors/extraction. Every addition here must be a conscious act
 * recorded in EXPECTED below; the goal is to keep this list SHRINKING over time
 * (toward black-box recipe-level fixtures), never expanding by accident.
 */

import { describe, expect, it } from 'vitest';

import * as internal from '../internal.js';

/** The complete, intended set of test-only value exports. Keep alphabetised. */
const EXPECTED_INTERNAL_EXPORTS = [
  'CatalogRepo',
  'GRAPH_STAGES',
  'HEAP_TARGETS',
  'MemoryPressureError',
  'alwaysThrowsBranchRule',
  'buildIndexes',
  'buildUnifiedReportLines',
  'decideHeapTargetMb',
  'duplicatedFunctionBodyRule',
  'executeGraph',
  // envelope-first-presentation RP-2: the graph live done-frame table node,
  // exported only for the host-side live/static parity proof.
  'graphDoneTableNode',
  'noSideEffectPathRule',
  'orphanSubtreeRule',
  'runGraph',
  'runHeapPreflight',
  'systemHasMemoryFor',
  'totalSystemMemoryMb',
].sort();

describe('@opensip-cli/graph/internal surface', () => {
  it('exposes exactly the intended test-only value surface', () => {
    const actual = Object.keys(internal)
      .filter((k) => internal[k as keyof typeof internal] !== undefined)
      .sort();
    expect(actual).toEqual(EXPECTED_INTERNAL_EXPORTS);
  });
});
