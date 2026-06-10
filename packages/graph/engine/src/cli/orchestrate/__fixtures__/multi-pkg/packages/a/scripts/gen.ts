// An OUT-OF-src-tree file inside @fixture/a (under `scripts/`, NOT `src/`). A
// per-package tsconfig that only `include`s `src/**` would EXCLUDE this file —
// the exact discovery gap Phase 0/1's canonical file set closed. It still lives
// under packages/a/, so the partitioner assigns it to the pkg-a shard (longest
// matching rootDir), NOT the root shard.
//
// genFixtures -> @fixture/foundation.canonicalize is a cross-package edge from a
// file the sharded build would historically have dropped; the gate proves the
// merged sharded catalog now contains it AND links it identically to exact.

import { canonicalize } from '@fixture/foundation';

export function genFixtures(seed: unknown): unknown {
  return canonicalize(seed);
}
