/**
 * Acceptance test (TDD baseline) for the instance-vs-global FileCache bug.
 *
 * This test is ACTIVE and RED by design on the Phase-0 tree. It demonstrates
 * the present-day shared-singleton bug: two logical runs share the module
 * singleton `fileCache`, so one run's `clear()` evicts the other's entries.
 *
 * The fitness engine's own tests must NOT import `@opensip-cli/test-support`
 * (the package graph would go cyclic), so this Phase-0 form uses the existing
 * module singleton directly. Phase 1 gives each scope its own
 * `scope.fitness.fileCache` (so an unrelated run's `clear()` cannot touch
 * another run's cache) and rewrites this test onto two scope-owned caches to
 * flip it green; Phase 4 adds the interleaving + identity cases.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { fileCache } from '../file-cache.js';

describe('concurrent fit runs do not share a file cache', () => {
  it("run A clear() must not evict run B entries (RED until Phase 1 gives each scope its own cache)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'opensip-concurrent-cache-'));
    const fileB = path.join(dir, 'run-b.ts');
    const contentB = 'export const b = 1;\n';
    writeFileSync(fileB, contentB);

    try {
      // Run B reads its file → cached in the (today shared) module singleton.
      await fileCache.get(fileB);
      expect(fileCache.getCached(fileB)).toBe(contentB);

      // Run A finishes and clears ITS cache. Today both runs resolve the same
      // module singleton, so this evicts run B's entry — the bug.
      fileCache.clear();

      // Run B's entry MUST survive an unrelated run's clear(). Fails today
      // (single shared Map). Phase 1 gives each scope a distinct
      // scope.fitness.fileCache so run A's clear() cannot reach run B's cache.
      expect(fileCache.getCached(fileB)).toBe(contentB);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
