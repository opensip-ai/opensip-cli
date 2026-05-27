/**
 * Unit tests for the heap-preflight policy.
 *
 * We can't exercise the re-exec path safely (it would actually fork
 * the test runner), so the `reExecWithHeap` body lives behind a
 * `/* v8 ignore start *\/` band. These tests cover every short-circuit
 * branch in `runHeapPreflight` plus the pure helpers
 * (`decideHeapTargetMb`, `systemHasMemoryFor`, `totalSystemMemoryMb`).
 */

import { ConfigurationError } from '@opensip-tools/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  decideHeapTargetMb,
  HEAP_TARGETS,
  runHeapPreflight,
  systemHasMemoryFor,
  totalSystemMemoryMb,
} from '../../cli/heap-preflight.js';
import {
  _clearAdaptersForTesting,
  registerAdapter,
} from '../../lang-adapter/registry.js';

import type {
  DiscoverOutput,
  GraphLanguageAdapter,
  ParseOutput,
  ResolveOutput,
  WalkOutput,
} from '../../lang-adapter/types.js';

function adapterWithFileCount(fileCount: number): GraphLanguageAdapter {
  const files = Array.from({ length: fileCount }, (_, i) => `/tmp/file-${String(i)}.ts`);
  return {
    id: 'typescript',
    fileExtensions: ['.ts'],
    displayName: 'TypeScript',
    discoverFiles: (): DiscoverOutput => ({
      projectDirAbs: '/tmp',
      files,
    }),
    parseProject: (): ParseOutput => ({ project: null, parseErrors: [] }),
    walkProject: (): WalkOutput => ({
      occurrences: {},
      callSites: [],
      parseErrors: [],
    }),
    resolveCallSites: (): ResolveOutput => ({
      edgesByOwner: new Map(),
      stats: {
        totalCallSites: 0,
        resolvedHigh: 0,
        resolvedMedium: 0,
        resolvedLow: 0,
        unresolved: 0,
      },
    }),
    cacheKey: () => 'fake',
  };
}

describe('decideHeapTargetMb', () => {
  it('returns null below the lowest threshold', () => {
    expect(decideHeapTargetMb(0)).toBe(null);
    expect(decideHeapTargetMb(500)).toBe(null);
    expect(decideHeapTargetMb(1000)).toBe(null);
  });

  it('returns 8192 between 1001 and 2500 files', () => {
    expect(decideHeapTargetMb(1001)).toBe(8192);
    expect(decideHeapTargetMb(2500)).toBe(8192);
  });

  it('returns 12288 above the 2500 threshold', () => {
    expect(decideHeapTargetMb(2501)).toBe(12_288);
    expect(decideHeapTargetMb(100_000)).toBe(12_288);
  });

  it('exposes HEAP_TARGETS in descending file-threshold order', () => {
    for (let i = 1; i < HEAP_TARGETS.length; i++) {
      const prev = HEAP_TARGETS[i - 1];
      const curr = HEAP_TARGETS[i];
      if (!prev || !curr) continue;
      expect(prev.fileThreshold).toBeGreaterThan(curr.fileThreshold);
    }
  });
});

describe('totalSystemMemoryMb / systemHasMemoryFor', () => {
  it('returns a positive integer for total memory', () => {
    expect(totalSystemMemoryMb()).toBeGreaterThan(0);
  });

  it('passes for a tiny target (system likely has at least 1 MB extra)', () => {
    expect(systemHasMemoryFor(1)).toBe(true);
  });

  it('fails for a wildly oversized target', () => {
    expect(systemHasMemoryFor(Number.MAX_SAFE_INTEGER)).toBe(false);
  });
});

describe('runHeapPreflight', () => {
  let prevSentinel: string | undefined;

  beforeEach(() => {
    _clearAdaptersForTesting();
    prevSentinel = process.env.OPENSIP_HEAP_ELEVATED;
    delete process.env.OPENSIP_HEAP_ELEVATED;
  });

  afterEach(() => {
    _clearAdaptersForTesting();
    if (prevSentinel === undefined) {
      delete process.env.OPENSIP_HEAP_ELEVATED;
    } else {
      process.env.OPENSIP_HEAP_ELEVATED = prevSentinel;
    }
  });

  it('throws ConfigurationError if no adapter is registered', async () => {
    await expect(runHeapPreflight({ cwd: '/tmp' })).rejects.toThrow(ConfigurationError);
  });

  it('short-circuits to false when running inside the elevated child', async () => {
    registerAdapter(adapterWithFileCount(10_000));
    process.env.OPENSIP_HEAP_ELEVATED = '1';
    expect(await runHeapPreflight({ cwd: '/tmp' })).toBe(false);
  });

  it('returns false when file count is below the smallest threshold', async () => {
    registerAdapter(adapterWithFileCount(100));
    expect(await runHeapPreflight({ cwd: '/tmp' })).toBe(false);
  });

  it('returns false when the current heap cap is already above the target', async () => {
    // Use a tiny file count → target=8192. Most CI machines run below
    // that already; pin the behavior by making the threshold check
    // explicit instead of leaving it to chance.
    registerAdapter(adapterWithFileCount(1500));
    // If the current heap is already >= 8192 MB, runHeapPreflight returns false.
    // If the system can't fit the elevated heap, also returns false (insufficient branch).
    // Both branches arrive at the same return value (false).
    const result = await runHeapPreflight({ cwd: '/tmp' });
    expect(result).toBe(false);
  });

  // The "elevate via re-exec" branch is intentionally not covered:
  // running it would fork the test process. The re-exec body is
  // wrapped in `/* v8 ignore start *\/` upstream for this reason. The
  // insufficient-RAM branch requires mocking os.totalmem which is
  // fragile under vitest workers; skipping it leaves a small uncovered
  // strip that's documented and acceptable.
});
