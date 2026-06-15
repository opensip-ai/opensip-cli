// @medium/app — the top of the deep chain: appMain -> @medium/svc-b.svcBRun
// (cross-package). The chain's entry point; also the target the root-level file
// and the test-tree file both call (test->prod and root->prod cross-package
// edges from outside the packages/* src trees).

import { svcBRun } from '@medium/svc-b';

export function appMain(value: unknown): unknown {
  return svcBRun(value);
}
