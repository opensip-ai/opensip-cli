import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { fileCache } from '@opensip-tools/fitness';

import type { Check } from '@opensip-tools/fitness';

/**
 * Write a single fixture file under cwd, creating directories as needed.
 * Returns the absolute path.
 */
function writeFixture(cwd: string, relPath: string, content: string): string {
  const absPath = join(cwd, relPath);
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, content);
  return absPath;
}

/**
 * Drive a Check against in-memory fixture files. Creates a temp dir,
 * writes the fixtures, and runs the check via its public `run()` method
 * with the fixture paths pinned via `targetFiles`. Returns the result and
 * a cleanup function the caller invokes from afterEach.
 *
 * Use this for any check that operates on file content. The check's own
 * scope/include/exclude logic is bypassed via `targetFiles`, which tests
 * the analyze logic in isolation from the targets layer.
 */
export async function runCheckOnFixtures(
  check: Check,
  fixtures: Record<string, string>,
): Promise<{ result: Awaited<ReturnType<Check['run']>>; cleanup: () => void; cwd: string }> {
   
  const cwd = mkdtempSync(join(tmpdir(), 'opensip-check-test-'));
  const targetFiles: string[] = [];
  for (const [relPath, content] of Object.entries(fixtures)) {
    targetFiles.push(writeFixture(cwd, relPath, content));
  }

  // Prewarm so the check's matchFiles() returns the fixtures.
  await fileCache.prewarm(cwd, ['**/*']);

  const result = await check.run(cwd, { targetFiles });
  return {
    result,
    cwd,
    cleanup: () => {
      fileCache.clear();
      rmSync(cwd, { recursive: true, force: true });
    },
  };
}

/** Convenience: signals where severity === 'high' (errors). */
export function errorSignals(result: Awaited<ReturnType<Check['run']>>) {
  return result.signals.filter((s) => s.severity === 'high');
}

/** Convenience: signals where severity === 'medium' (warnings). */
export function warningSignals(result: Awaited<ReturnType<Check['run']>>) {
  return result.signals.filter((s) => s.severity === 'medium');
}
