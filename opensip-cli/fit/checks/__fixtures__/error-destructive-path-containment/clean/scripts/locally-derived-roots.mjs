// CLEAN fixture for `error-destructive-path-containment` — LOCALLY-DERIVED roots.
//
// Reduced from real call sites in this repo that are correct by construction and
// must never fire:
//   packages/cli/src/bootstrap/capability-worker/supervisor.ts L31/L43
//   packages/graph/engine/src/cli/orchestrate/shard-runner.ts   L420-422/L459
//   packages/cli/src/bootstrap/artifact-retention.ts            L123-128
//   packages/cli/src/telemetry/profile-artifact-index.ts        L306
//
// Expected: ZERO findings.

import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 1. The process created the directory, so it owns it.
export async function withWorkerSpecDir(run) {
  const dir = mkdtempSync(join(tmpdir(), 'opensip-capability-worker-'));
  try {
    return await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 2. Declared first, assigned from an owned producer inside the try.
export function withShardSpecDir(run) {
  let specDir;
  try {
    specDir = mkdtempSync(join(tmpdir(), 'graph-shard-'));
    return run(specDir);
  } finally {
    if (specDir !== undefined) rmSync(specDir, { recursive: true, force: true });
  }
}

// 3. A `for…of` binding over entries this function itself listed.
export function pruneRetention(artifactsDir, tool, keep) {
  const toolDir = join(artifactsDir, tool);
  const runDirs = readdirSync(toolDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ full: join(toolDir, entry.name) }));
  for (const stale of runDirs.slice(keep)) {
    rmSync(stale.full, { recursive: true, force: true });
  }
}

// 4. `force: true` WITHOUT `recursive: true` is an atomic-write cleanup, not a
//    tree delete — out of scope even though `temporaryPath` is a parameter.
export function discardPartialWrite(temporaryPath) {
  rmSync(temporaryPath, { force: true });
}
