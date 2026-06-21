// @eq/single — the same logical node as app.appRun. Its edge -> helpFmt is now
// a relative intra-package import. There is NO decoy file here: in a
// single-package repo there is no separate package to host a phantom collision,
// so the trap is vacuously satisfied (one bucket, one baseValue).

import { helpFmt } from './helper.js';

export function appRun(input: unknown): string {
  return helpFmt(input);
}
