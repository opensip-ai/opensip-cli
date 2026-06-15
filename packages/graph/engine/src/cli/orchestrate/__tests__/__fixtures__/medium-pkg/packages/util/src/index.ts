// @medium/util — formatting helpers + the other leg of the cross-package cycle.
//
// Shapes exercised here:
//   - utilFormat -> ./helpers.utilHelper : RELATIVE intra-package edge (path-pin).
//   - utilCycle  -> @medium/core.coreCycle : the SECOND leg of the CROSS-PACKAGE
//     CYCLE (util -> core -> util). Together with core.coreCycle this forms the
//     2-member SCC the gate diffs.

import { coreCycle } from '@medium/core';

import { utilHelper } from './helpers.js';

export function utilFormat(value: unknown): unknown {
  return utilHelper(value);
}

export function utilCycle(depth: unknown): unknown {
  return coreCycle(depth);
}
