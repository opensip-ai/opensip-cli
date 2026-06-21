// @eq/app — the top package (the caller).
//
//   1. appRun -> @eq/util.helpFmt   (GENUINE cross-package edge, bare workspace
//      specifier). Must resolve to UTIL's helpFmt.
//   2. baseValue (below) is a same-named DECOY of @eq/core.baseValue. @eq/util
//      never imports @eq/app, so util.helpFmt must NEVER link to this decoy —
//      the phantom trap. It has no in-project callers; it exists only to bait a
//      name-only resolver.

import { helpFmt } from '@eq/util';

export function appRun(input: unknown): string {
  return helpFmt(input);
}

export function baseValue(value: unknown): unknown {
  return value;
}
