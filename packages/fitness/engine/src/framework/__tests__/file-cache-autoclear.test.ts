/**
 * Auto-clear timer disposal / leak test (parallel-tool-invocations Phase 4).
 *
 * `FileCache.prewarm()` arms an unref'd 10-minute `setTimeout`
 * (`file-cache.ts:scheduleAutoClear`) as a backstop against a missed lifecycle
 * `clear()`. Many short-lived scopes would each leak such a timer until GC.
 * Phase 1 made fitness register a disposer on `RunScope` that calls the cache's
 * `clear()` (which `clearTimeout`s the auto-clear timer at `file-cache.ts:181-184`).
 *
 * These tests pin that contract:
 *   - `clear()` cancels the armed auto-clear timer (timer count drops to zero);
 *   - disposing a scope whose fitness cache was prewarmed clears the cache AND
 *     leaves no pending auto-clear timer;
 *   - a soak of N create+prewarm+dispose cycles leaves zero dangling timers
 *     (no per-scope timer leak).
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

describe('FileCache auto-clear timer disposal', () => {
  beforeEach(() => {
    // Fake timers so getTimerCount() observes the unref'd setTimeout. fs promises
    // used by prewarm resolve via the (un-faked) microtask/IO queue, so awaiting
    // prewarm still works under fake timers.
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('prewarm arms a timer; clear() cancels it (getTimerCount drops to zero)', async () => {
    const dir = makePrewarmDir();
    const cache = new FileCache();
    try {
      expect(vi.getTimerCount()).toBe(0);

      await cache.prewarm(dir, ['**/*.ts']);
      // The unref'd auto-clear setTimeout is now armed.
      expect(vi.getTimerCount()).toBe(1);
      expect(cache.stats.size).toBeGreaterThan(0);

      // clear() is the disposer path — it must clearTimeout the auto-clear timer.
      cache.clear();
      expect(vi.getTimerCount()).toBe(0);
      expect(cache.stats.size).toBe(0);

      // Advancing past the 10-minute mark must NOT fire a cancelled timer
      // (no second clear side effect; the count is already zero).
      vi.advanceTimersByTime(11 * 60 * 1000);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('scope.dispose() clears a prewarmed fitness cache and cancels its auto-clear timer', async () => {
    const dir = makePrewarmDir();
    const scope = new RunScope();
    applyToolContributeScope(scope, fitnessTool);
    const cache = scope.fitness?.fileCache;
    if (!cache) throw new Error('expected scope.fitness.fileCache to be installed');

    try {
      await cache.prewarm(dir, ['**/*.ts']);
      expect(cache.stats.size).toBeGreaterThan(0);
      expect(vi.getTimerCount()).toBe(1);

      // dispose() runs the fitness-registered disposer → cache.clear() →
      // clearTimeout. (Phase 1 task 1.3 path: contributeScope returns the
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
        // While alive, exactly one timer is armed for THIS scope's cache.
        expect(vi.getTimerCount()).toBe(1);

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
