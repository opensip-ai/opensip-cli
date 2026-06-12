/**
 * Structural-sync drift guard for the duplicated `GateCompareResult` (ADR-0036,
 * P2 Task 2.2 → P6 Task 6.6).
 *
 * `core` declares a THIN local `GateCompareResult` for the `compareBaseline` seam
 * return type because `core` must NOT import `@opensip-tools/output` (which owns
 * the authoritative `GateCompareResult` consumed by `diffBaseline`). The two are
 * duplicated by necessity across the layer boundary, so they can silently drift.
 * This test pins them mutually-equal at COMPILE time — an added/renamed/retyped
 * field on either side breaks the typecheck.
 *
 * It lives in `output` (not `core`) because `output → core` is a legal layer edge,
 * so a test here may import BOTH types; a test in `core` could not reach `output`.
 */

import { describe, expectTypeOf, it } from 'vitest';

import type { GateCompareResult as OutputGateCompareResult } from '../baseline-diff.js';
import type { GateCompareResult as CoreGateCompareResult } from '@opensip-tools/core';

describe('GateCompareResult structural sync (core ↔ output)', () => {
  it('the two duplicated interfaces are exactly equal (drift guard)', () => {
    expectTypeOf<CoreGateCompareResult>().toEqualTypeOf<OutputGateCompareResult>();
    expectTypeOf<OutputGateCompareResult>().toEqualTypeOf<CoreGateCompareResult>();
  });
});
