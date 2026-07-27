/**
 * File-cache lifecycle disposal test (Plan 01 resiliency migration).
 *
 * FileCache is owned by RunScope and cleared by its disposer. It deliberately
 * carries no wall-clock auto-clear timer: a long-running fit must not lose its
 * prewarmed universe ten minutes into a live run.
 *
 * These tests pin that contract:
 *   - prewarm arms no timer;
 *   - disposing a scope clears the cache;
 *   - a soak of N create+prewarm+dispose cycles leaves zero dangling timers.
 *
 * Uses Vitest fake timers so `vi.getTimerCount()` observes the armed/cancelled
 * `setTimeout` deterministically (the 10-minute real delay is never waited on).
 * The fitness engine's own tests must NOT import `@opensip-cli/test-support`
 * (cyclic), so scopes are built from `@opensip-cli/core` directly and the
 * fitness subscope is installed via core's `applyToolContributeScope` (the same
 * unwrap-and-register seam production uses).
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { applyToolContributeScope, RunScope } from '@opensip-cli/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fitnessTool } from '../../tool.js';
import { FileCache } from '../file-cache.js';

/** Make a temp dir with one TS file so prewarm has something to load (and arm). */
function makePrewarmDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'opensip-autoclear-'));
  writeFileSync(path.join(dir, 'a.ts'), 'export const a = 1;\n');
  return dir;
}

describe('FileCache scope-owned disposal', () => {
  beforeEach(() => {
    // Fake timers so getTimerCount() observes the unref'd setTimeout. fs promises
    // used by prewarm resolve via the (un-faked) microtask/IO queue, so awaiting
    // prewarm still works under fake timers.
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('prewarm does not arm a wall-clock cache eviction timer', async () => {
    const dir = makePrewarmDir();
    const cache = new FileCache();
    try {
      expect(vi.getTimerCount()).toBe(0);

      await cache.prewarm(dir, ['**/*.ts']);
      expect(vi.getTimerCount()).toBe(0);
      expect(cache.stats.size).toBeGreaterThan(0);

      // clear() is the explicit disposer path.
      cache.clear();
      expect(vi.getTimerCount()).toBe(0);
      expect(cache.stats.size).toBe(0);

      // Advancing past the former ten-minute mark cannot clear a live cache.
      vi.advanceTimersByTime(11 * 60 * 1000);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('scope.dispose() clears a prewarmed fitness cache', async () => {
    const dir = makePrewarmDir();
    const scope = new RunScope();
    applyToolContributeScope(scope, fitnessTool);
    const cache = scope.fitness?.fileCache;
    if (!cache) throw new Error('expected scope.fitness.fileCache to be installed');

    try {
      await cache.prewarm(dir, ['**/*.ts']);
      expect(cache.stats.size).toBeGreaterThan(0);
      expect(vi.getTimerCount()).toBe(0);

      // dispose() runs the fitness-registered disposer → cache.clear().
      // (Phase 1 task 1.3 path: contributeScope returns the
      // disposer; applyToolContributeScope registers it via scope.onDispose.)
      scope.dispose();

      expect(cache.stats.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('soak: N create+prewarm+dispose cycles leave zero dangling timers', async () => {
    const dir = makePrewarmDir();
    const N = 8;
    try {
      for (let i = 0; i < N; i++) {
        const scope = new RunScope();
        applyToolContributeScope(scope, fitnessTool);
        const cache = scope.fitness?.fileCache;
        if (!cache) throw new Error('expected scope.fitness.fileCache to be installed');

        await cache.prewarm(dir, ['**/*.ts']);
        // A live scope owns data, but no timer that could evict it mid-run.
        expect(vi.getTimerCount()).toBe(0);

        scope.dispose();
        // After dispose, no timer survives → next iteration starts from zero.
        expect(vi.getTimerCount()).toBe(0);
      }
      // No accumulation across all N cycles.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
