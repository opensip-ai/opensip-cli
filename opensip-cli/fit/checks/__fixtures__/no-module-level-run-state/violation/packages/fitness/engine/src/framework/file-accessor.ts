// FIXTURE — VIOLATION (no-module-level-run-state).
//
// A production tool-engine file that VALUE-imports the test-only barrel
// `fileCache` and reads through it. This is the regression the check forbids:
// the per-run FileCache must come from scope.fitness.fileCache, never the
// process-global singleton. The fixture path embeds
// `packages/fitness/engine/src/framework/` so the check's TOOL_ENGINE_PATH
// guard matches; the filename is a non-exempt tool-engine reader.
//
// Expected: the check FIRES (exactly one finding) on the value-import line.

// eslint-disable-next-line -- fixture: deliberate forbidden import (never compiled)
import { fileCache } from './file-cache.js';

export async function readSource(filePath: string): Promise<string> {
  return fileCache.get(filePath);
}
