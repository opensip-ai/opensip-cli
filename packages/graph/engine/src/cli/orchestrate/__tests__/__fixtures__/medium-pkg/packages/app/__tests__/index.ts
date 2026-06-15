// @medium/app — a REAL TEST-tree file (kept in the canonical set, both engines).
// testApp -> @medium/app.appMain is a test->production cross-package edge. The
// test tree is a divergence class the canonical file set deliberately KEEPS
// (test-only-reachable + test->prod blast need it), so the sharded build must
// shard it and link its cross-package call identically to exact.

import { appMain } from '@medium/app';

export function testApp(value: unknown): unknown {
  return appMain(value);
}
