// @medium/svc-a — mid-tier service. The first hop of the DEEP CROSS-PACKAGE
// CHAIN: svcARun fans out to BOTH foundation packages.
//   - svcARun -> @medium/core.coreInit  (cross-package)
//   - svcARun -> @medium/util.utilFormat (cross-package)
// The full chain app -> svc-b -> svc-a -> {core,util} must be recovered edge-for
// -edge by the sharded linker, identically to the single-program build.

import { coreInit } from '@medium/core';
import { utilFormat } from '@medium/util';

export function svcARun(value: unknown): unknown {
  const initialized = coreInit(value);
  return utilFormat(initialized);
}
