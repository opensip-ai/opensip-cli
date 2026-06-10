// @medium/svc-b — the next hop of the deep chain: svcBRun -> @medium/svc-a.svcARun
// (cross-package). Proves a multi-hop cross-package chain (app -> svc-b -> svc-a
// -> core/util) resolves transitively the same in both engines.

import { svcARun } from '@medium/svc-a';

export function svcBRun(value: unknown): unknown {
  return svcARun(value);
}
