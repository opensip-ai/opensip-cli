// CLEAN fixture for `error-destructive-path-containment` — OWNERSHIP MARKER.
//
// Reduced from a REAL call site in this repo:
//   scripts/bench-partition-strategies.mjs (L124, L156-158, L179-181)
//
// `--corpus` IS an argv-supplied path and IS recursively deleted, which is the
// same surface shape as the violation fixture. The difference is the ownership
// proof: the delete only runs when the directory carries the generator's own
// marker file. An existing directory WITHOUT that marker is classified as a
// real corpus and is never touched, so `--corpus ~/important` cannot be
// destroyed.
//
// This is the pattern that separates a proven delete from a blast radius, and
// it is why the check keys on this repo's `*Marker` guard vocabulary rather
// than on "is the path a parameter".
//
// Expected: ZERO findings.

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function prepareCorpus(args) {
  const corpusDir = args.corpus ?? join(tmpdir(), 'opensip-flat-large-fixture');

  // A real corpus is an EXISTING directory without the fixture marker file.
  const fixtureMarker = join(corpusDir, 'src', 'd0', 'f0000.ts');
  const isRealCorpus = existsSync(corpusDir) && !existsSync(fixtureMarker);

  if (isRealCorpus) return { corpusDir, generated: false };

  if (args.fresh) {
    // Only reachable when corpusDir is absent or is one of OUR fixtures.
    rmSync(corpusDir, { recursive: true, force: true });
  }
  return { corpusDir, generated: true };
}
