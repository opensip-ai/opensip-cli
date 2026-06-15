// A ROOT-LEVEL source file (under no packages/* unit) — it lands in the
// synthetic `:root` shard in the sharded build. Phase 2 must cover it: the
// `:root` shard must not crash the manifest/export-index lookups, and a bare
// workspace import from a root file must still link to the imported package's
// unique export, identically to the single-program build.
//
// rootMain -> @fixture/foundation.canonicalize is a GENUINE cross-package edge
// originating OUTSIDE packages/* (packageOf(root file) is `<unknown>`), proving
// boundary linking works from the root shard, not just package shards.

import { canonicalize } from '@fixture/foundation';

export function rootMain(value: unknown): unknown {
  return canonicalize(value);
}
