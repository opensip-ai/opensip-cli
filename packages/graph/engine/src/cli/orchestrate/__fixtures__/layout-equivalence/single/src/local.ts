// @eq/single — the same logical node as util.localPad, reached by a relative
// import (intra-package, as it must be in a single-package repo).

export function localPad(value: unknown): string {
  return String(value);
}
