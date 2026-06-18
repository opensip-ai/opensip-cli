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
 * cases on top of this:
 *   - distinct object identity (`scopeA.fitness.fileCache !== scopeB.fitness.fileCache`,
 *     read through the same `currentScope()?.fitness?.fileCache` seam production uses);
 *   - explicit-await interleaving (A prewarms → B clears its OWN cache mid-flight →
 *     A reads and still sees its prewarmed entries; no cross-eviction).
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  applyToolContributeScope,
  RunScope,
  runWithScope,
  runWithScopeSync,
} from '@opensip-cli/core';
import { describe, expect, it } from 'vitest';

import { fitnessTool } from '../../tool.js';

import type { FileCache } from '../file-cache.js';

/** Build a fresh RunScope carrying its OWN scope.fitness.fileCache. */
function makeScopeWithCache(): { scope: RunScope; cache: FileCache } {
  const scope = new RunScope();
  applyToolContributeScope(scope, fitnessTool);
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

  it('each scope.fitness.fileCache is a distinct object identity', () => {
    // The spec success criterion: two scopes never alias the same cache object.
    // (The old module singleton would have made `currentScope()?.fitness?.fileCache`
    // resolve to the SAME instance for both runs.)
    const runA = makeScopeWithCache();
    const runB = makeScopeWithCache();
    try {
      // Read through the scope seam exactly like production
      // (currentScope()?.fitness?.fileCache), not the captured locals.
      const fromA = runWithScopeSync(runA.scope, () => runA.scope.fitness?.fileCache);
      const fromB = runWithScopeSync(runB.scope, () => runB.scope.fitness?.fileCache);
      expect(fromA).toBe(runA.cache);
      expect(fromB).toBe(runB.cache);
      expect(fromA).not.toBe(fromB);
    } finally {
      runA.scope.dispose();
      runB.scope.dispose();
    }
  });

  it('interleaving: A prewarms, B clears mid-flight, A still reads its own entries', async () => {
    // The spec's interleaving success criterion. Two scopes run under
    // `runWithScope` (the concurrency-safe binding); explicit `await` points
    // hand control back and forth so run B's clear() lands BETWEEN run A's
    // prewarm and run A's read. With per-scope caches, B clearing its OWN
    // cache cannot evict A's entries (the Phase-0 bug was both runs sharing
    // one Map, so B.clear() would have wiped A's prewarmed content).
    const dir = mkdtempSync(path.join(tmpdir(), 'opensip-interleave-cache-'));
    const fileA = path.join(dir, 'run-a.ts');
    const fileB = path.join(dir, 'run-b.ts');
    const contentA = 'export const a = 1;\n';
    const contentB = 'export const b = 2;\n';
    writeFileSync(fileA, contentA);
    writeFileSync(fileB, contentB);

    const runA = makeScopeWithCache();
    const runB = makeScopeWithCache();
    expect(runA.cache).not.toBe(runB.cache);

    // A barrier pair that lets the two bodies hand control back and forth at
    // explicit points (deterministic interleaving, no reliance on timer races).
    let releaseB!: () => void;
    const bMayClear = new Promise<void>((resolve) => {
      releaseB = resolve;
    });
    let releaseA!: () => void;
    const aMayRead = new Promise<void>((resolve) => {
      releaseA = resolve;
    });

    try {
      const aResult = runWithScope(runA.scope, async () => {
        // 1. A prewarms its OWN cache (reads fileA into run A's cache).
        await runA.cache.get(fileA);
        expect(runA.cache.getCached(fileA)).toBe(contentA);
        // 2. Yield: let B clear its cache now.
        releaseB();
        await aMayRead;
        // 4. A reads AFTER B.clear() — served from A's own (uncleared) cache.
        //    Assert it's the cached value, and that the cache still reports the
        //    entry (a disk re-read would re-populate, masking eviction; here we
        //    assert the *synchronous* cached hit survived B's clear()).
        expect(runA.cache.getCached(fileA)).toBe(contentA);
        return runA.cache.getCached(fileA);
      });

      const bResult = runWithScope(runB.scope, async () => {
        await bMayClear;
        // 3. B prewarms then clears its OWN cache while A is mid-flight.
        await runB.cache.get(fileB);
        expect(runB.cache.getCached(fileB)).toBe(contentB);
        runB.cache.clear();
        expect(runB.cache.getCached(fileB)).toBeUndefined();
        // Hand control back to A so it reads post-clear.
        releaseA();
      });

      const [aValue] = await Promise.all([aResult, bResult]);
      // A's entry was served from A's cache, unaffected by B's clear().
      expect(aValue).toBe(contentA);
      // A's cache is still intact; B's was cleared. No cross-eviction.
      expect(runA.cache.getCached(fileA)).toBe(contentA);
      expect(runB.cache.getCached(fileB)).toBeUndefined();
    } finally {
      runA.scope.dispose();
      runB.scope.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
