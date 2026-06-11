/**
 * Unit tests for heap-preflight decision logic.
 *
 * The re-exec path is not exercised here — that requires spawning a
 * real child process and is covered by manual smoke testing. These
 * tests pin the pure decision functions so the policy thresholds
 * (1000 → 8192, 2500 → 12288) can't drift silently.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RunScope, runWithScope, runWithScopeSync } from '@opensip-tools/core';
import { currentAdapterRegistry, graphTool } from '@opensip-tools/graph';
import {
  HEAP_TARGETS,
  decideHeapTargetMb,
  runHeapPreflight,
  systemHasMemoryFor,
  totalSystemMemoryMb,
} from '@opensip-tools/graph/internal';
import { pythonGraphAdapter } from '@opensip-tools/graph-python';
import { rustGraphAdapter } from '@opensip-tools/graph-rust';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { typescriptGraphAdapter } from '../index.js';

describe('decideHeapTargetMb', () => {
  it('returns null below the lowest threshold', () => {
    expect(decideHeapTargetMb(0)).toBeNull();
    expect(decideHeapTargetMb(999)).toBeNull();
    expect(decideHeapTargetMb(1000)).toBeNull();
  });

  it('returns 8192 between the two thresholds (exclusive 1000, inclusive 2500)', () => {
    expect(decideHeapTargetMb(1001)).toBe(8192);
    expect(decideHeapTargetMb(2000)).toBe(8192);
    expect(decideHeapTargetMb(2500)).toBe(8192);
  });

  it('returns 12288 above the upper threshold', () => {
    expect(decideHeapTargetMb(2501)).toBe(12_288);
    expect(decideHeapTargetMb(10_000)).toBe(12_288);
  });

  it('exposes thresholds in descending order so future additions stay correct', () => {
    const thresholds = HEAP_TARGETS.map((t) => t.fileThreshold);
    const sorted = [...thresholds].sort((a, b) => b - a);
    expect(thresholds).toEqual(sorted);
  });
});

describe('systemHasMemoryFor', () => {
  it('reports true for a tiny ask the system can clearly satisfy', () => {
    expect(systemHasMemoryFor(64)).toBe(true);
  });

  it('reports false for an impossibly large ask', () => {
    const huge = totalSystemMemoryMb() + 1_000_000;
    expect(systemHasMemoryFor(huge)).toBe(false);
  });

  it('keeps a 2 GB OS headroom — denying asks that would consume all RAM', () => {
    const totalMb = totalSystemMemoryMb();
    // Ask for exactly total - 1 GB. The 2 GB headroom should refuse.
    expect(systemHasMemoryFor(totalMb - 1024)).toBe(false);
  });
});

describe('runHeapPreflight', () => {
  let dir: string;
  let originalSentinel: string | undefined;
  let scope: RunScope;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'graph-preflight-'));
    mkdirSync(dir, { recursive: true });
    // Empty tsconfig — discoverFiles must succeed without errors.
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { target: 'ES2022' }, include: ['**/*.ts'] }),
      'utf8',
    );
    // Ensure at least one .ts file exists so the tsconfig is not empty.
    writeFileSync(join(dir, 'index.ts'), 'export const x = 1;\n', 'utf8');
    originalSentinel = process.env.OPENSIP_HEAP_ELEVATED;
    // Item 1: adapter registry is per-RunScope. Construct a fresh
    // scope, attach graph subscope, and register the adapters this test imports
    // so runHeapPreflight()'s pickAdapter() resolves them.
    scope = new RunScope();
    Object.assign(scope, graphTool.contributeScope?.() ?? {});
    runWithScopeSync(scope, () => {
      currentAdapterRegistry().register(typescriptGraphAdapter);
      currentAdapterRegistry().register(pythonGraphAdapter);
      currentAdapterRegistry().register(rustGraphAdapter);
    });
  });

  afterEach(() => {
    runWithScopeSync(scope, () => currentAdapterRegistry().clear());
    rmSync(dir, { recursive: true, force: true });
    if (originalSentinel === undefined) {
      delete process.env.OPENSIP_HEAP_ELEVATED;
    } else {
      process.env.OPENSIP_HEAP_ELEVATED = originalSentinel;
    }
  });

  function runScopedHeapPreflight(options: Parameters<typeof runHeapPreflight>[0]) {
    return runWithScope(scope, () => runHeapPreflight(options));
  }

  it('returns false (no-op) when SENTINEL is set (we are the elevated child)', async () => {
    process.env.OPENSIP_HEAP_ELEVATED = '1';
    const out = await runScopedHeapPreflight({ cwd: dir });
    expect(out).toBe(false);
  });

  it('returns false when file count is below the lowest threshold', async () => {
    delete process.env.OPENSIP_HEAP_ELEVATED;
    // Fixture has zero .ts files so file count is 0.
    const out = await runScopedHeapPreflight({ cwd: dir });
    expect(out).toBe(false);
  });

  it('returns false when current heap already meets target', async () => {
    delete process.env.OPENSIP_HEAP_ELEVATED;
    // Mock decideHeapTargetMb indirectly by mocking pickAdapter to
    // return more files than the threshold. Easiest: actually create
    // many files. We use 1100 small files to exceed the 1000 threshold.
    // To avoid a slow test, mock the discover stage by temporarily
    // shimming pickAdapter via a test util — but we don't have that.
    // Instead, write 1001 small files; small enough to be quick.
    for (let i = 0; i < 1001; i++) {
      writeFileSync(
        join(dir, `f${String(i)}.ts`),
        `export const x${String(i)} = ${String(i)};\n`,
        'utf8',
      );
    }
    // Default Node test heap is ~4096MB which exceeds the 8192 target
    // ONLY if we crank it high. To force the "already elevated" branch,
    // mock currentHeapLimitMb via vi: spy on v8.getHeapStatistics.
    const v8 = await import('node:v8');
    const spy = vi.spyOn(v8.default, 'getHeapStatistics').mockReturnValue({
      total_heap_size: 0,
      total_heap_size_executable: 0,
      total_physical_size: 0,
      total_available_size: 0,
      used_heap_size: 0,
      heap_size_limit: 64 * 1024 * 1024 * 1024, // 64 GB cap → already over 8192MB
      malloced_memory: 0,
      peak_malloced_memory: 0,
      does_zap_garbage: 0,
      number_of_native_contexts: 0,
      number_of_detached_contexts: 0,
      total_global_handles_size: 0,
      used_global_handles_size: 0,
      external_memory: 0,
    });
    try {
      const out = await runScopedHeapPreflight({ cwd: dir });
      expect(out).toBe(false); // already-elevated path
    } finally {
      spy.mockRestore();
    }
  });

  it('returns false when system has insufficient memory for elevated heap', async () => {
    delete process.env.OPENSIP_HEAP_ELEVATED;
    // Same setup: 1001 files crosses the 1000 threshold so a target of
    // 8192MB is decided. To force the "insufficient memory" branch,
    // mock os.totalmem to return very little.
    for (let i = 0; i < 1001; i++) {
      writeFileSync(
        join(dir, `f${String(i)}.ts`),
        `export const x${String(i)} = ${String(i)};\n`,
        'utf8',
      );
    }
    const os = await import('node:os');
    const spy = vi.spyOn(os.default, 'totalmem').mockReturnValue(512 * 1024 * 1024); // 512 MB
    let stderr = '';
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      stderr += typeof chunk === 'string' ? chunk : String(chunk);
      return true;
    });
    try {
      const out = await runScopedHeapPreflight({ cwd: dir });
      expect(out).toBe(false);
      expect(stderr).toContain('Continuing with current heap');
    } finally {
      spy.mockRestore();
      errSpy.mockRestore();
    }
  });
});
