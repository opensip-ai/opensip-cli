/**
 * Acceptance test for the instance-vs-global FileCache bug
 * (parallel-tool-invocations Phase 1).
 *
 * Was RED on the Phase-0 tree: two logical runs shared the module singleton
 * `fileCache`, so one run's `clear()` evicted the other's entries. Phase 1 gives
 * each `RunScope` its OWN `scope.fitness.fileCache` (built by the fitness tool's
 * `contributeScope()`), so an unrelated run's `clear()` can no longer touch
 * another run's cache. This rewrite onto two distinct scope-owned caches flips
 * it green.
 *
 * The fitness engine's own tests must NOT import `@opensip-cli/test-support`
 * (the package graph would go cyclic), so we construct the `RunScope`s directly
 * from `@opensip-cli/core` and populate each scope's fitness subscope via the
 * fitness tool's `contributeScope()` (through `installFitnessSubscope`, the same
 * unwrap-and-install seam production uses). Phase 4 adds interleaving + identity
 * cases on top of this.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { RunScope } from '@opensip-cli/core';
import { describe, expect, it } from 'vitest';

import { fitnessTool } from '../../tool.js';
import { installFitnessSubscope } from '../scope-registry.js';

import type { FileCache } from '../file-cache.js';

/** Build a fresh RunScope carrying its OWN scope.fitness.fileCache. */
function makeScopeWithCache(): { scope: RunScope; cache: FileCache } {
  const scope = new RunScope();
  installFitnessSubscope(scope, fitnessTool.contributeScope?.() ?? {});
  const cache = scope.fitness?.fileCache;
  if (!cache) throw new Error('expected scope.fitness.fileCache to be installed');
  return { scope, cache };
}

describe('concurrent fit runs do not share a file cache', () => {
  it('run A clear() must not evict run B entries (each scope owns its own cache)', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'opensip-concurrent-cache-'));
    const fileB = path.join(dir, 'run-b.ts');
    const contentB = 'export const b = 1;\n';
    writeFileSync(fileB, contentB);

    // Two independent runs → two independent scope-owned caches.
    const runA = makeScopeWithCache();
    const runB = makeScopeWithCache();

    // The two scopes carry DISTINCT cache instances (no shared module singleton).
    expect(runA.cache).not.toBe(runB.cache);

    try {
      // Run B reads its file → cached in run B's OWN cache.
      await runB.cache.get(fileB);
      expect(runB.cache.getCached(fileB)).toBe(contentB);

      // Run A finishes and clears ITS cache. With per-scope caches this cannot
      // reach run B's entries (the Phase-0 bug was both runs sharing one Map).
      runA.cache.clear();

      // Run B's entry survives the unrelated run's clear().
      expect(runB.cache.getCached(fileB)).toBe(contentB);
    } finally {
      runA.scope.dispose();
      runB.scope.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
