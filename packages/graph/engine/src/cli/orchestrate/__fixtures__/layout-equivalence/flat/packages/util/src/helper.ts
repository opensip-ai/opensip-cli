// @eq/util — the middle package.
//
// `helpFmt` has two edges the equivalence gate pins:
//   1. helpFmt -> @eq/core.baseValue   (GENUINE cross-package edge, bare
//      workspace specifier). Must resolve to CORE's baseValue, never app's decoy.
//   2. helpFmt -> ./local.localPad     (relative INTRA-package edge, path-pinned).

import { baseValue } from '@eq/core';

import { localPad } from './local.js';

export function helpFmt(input: unknown): string {
  const normalized = baseValue(input);
  return localPad(normalized);
}
