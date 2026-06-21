// @eq/single — the same logical node as util.helpFmt. Its two edges
// (-> baseValue, -> localPad) are now BOTH relative intra-package imports.

import { baseValue } from './base.js';

import { localPad } from './local.js';

export function helpFmt(input: unknown): string {
  const normalized = baseValue(input);
  return localPad(normalized);
}
