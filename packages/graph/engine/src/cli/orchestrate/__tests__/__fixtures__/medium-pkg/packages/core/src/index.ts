// @medium/core — the leaf-ish foundation.
//
// Shapes exercised here:
//   - coreInit -> coreHelper          : intra-file same-package edge.
//   - coreCycle -> @medium/util.utilCycle : one leg of the CROSS-PACKAGE CYCLE
//     (core -> util -> core). The merged sharded SCC must equal exact's: a
//     2-package strongly-connected component { coreCycle, utilCycle }.

import { utilCycle } from '@medium/util';

export function coreInit(value: unknown): unknown {
  return coreHelper(value);
}

export function coreHelper(value: unknown): unknown {
  return value;
}

export function coreCycle(depth: unknown): unknown {
  // Closes the cross-package cycle: util.utilCycle calls back into coreCycle.
  return utilCycle(depth);
}
