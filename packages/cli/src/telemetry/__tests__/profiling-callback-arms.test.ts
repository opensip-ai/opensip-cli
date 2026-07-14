/**
 * Deterministic profiler failure-path coverage using a synchronous fake inspector.
 * The production API is async, but the fake never starts Node's process-global
 * profiler, keeping coverage-v8 isolated and deterministic.
 */

import { readFileSync } from 'node:fs';

import { logger } from '@opensip-cli/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PROFILING_INSPECTOR_TIMEOUT_MS,
  resetProfilingForTests,
  startProfiling,
  stopProfiling,
} from '../profiling.js';

import { createProfilingHarness, GATE } from './fixtures/profiling-test-harness.js';

import type { RunScope } from '@opensip-cli/core';

const h = createProfilingHarness();

describe('CPU profiling callback and cleanup arms', () => {
  let scope: RunScope;

  beforeEach(() => {
    process.env[GATE] = '1';
    scope = h.scopeFor();
  });

  it('writes labels after start and a profile on awaited stop', async () => {
    h.installSyncFakeSession({ profile: { nodes: [], samples: [] } });

    const artifacts = await startProfiling(scope, 'fit:run');
    expect(h.readdirHasLabels()).toBe(true);
    const labels = JSON.parse(readFileSync(artifacts?.labelsPath ?? '', 'utf8')) as Record<
      string,
      unknown
    >;
    expect(labels.runId).toBe('RUN_PROF_1');
    expect(labels.command).toBe('fit:run');

    const info = vi.spyOn(logger, 'info');
    const complete = await stopProfiling(scope);
    expect(h.readdirHasCpuprofile()).toBe(true);
    expect(complete?.status).toBe('complete');
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ evt: 'cli.profiling.stopped' }));
  });

  it('logs and writes no profile when Profiler.stop returns an error', async () => {
    h.installSyncFakeSession({ stopError: new Error('profiler exploded') });
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    await startProfiling(scope, 'fit');
    await expect(stopProfiling(scope)).resolves.toBeUndefined();

    expect(h.readdirHasLabels()).toBe(false);
    expect(h.readdirHasCpuprofile()).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ evt: 'cli.profiling.stop_failed', error: 'profiler exploded' }),
    );
  });

  it('does not write a profile when Profiler.stop returns no payload', async () => {
    h.installSyncFakeSession({ profile: undefined });

    await startProfiling(scope, 'fit');
    await expect(stopProfiling(scope)).resolves.toBeUndefined();

    expect(h.readdirHasLabels()).toBe(false);
    expect(h.readdirHasCpuprofile()).toBe(false);
  });

  it.each(['Profiler.enable', 'Profiler.start'] as const)(
    'times out a withheld %s callback and ignores its late reply',
    async (deferMethod) => {
      vi.useFakeTimers();
      try {
        const flags = h.installSyncFakeSession({ deferMethod, profile: { nodes: [] } });
        const operation = startProfiling(scope, 'fit');
        await Promise.resolve();

        await vi.advanceTimersByTimeAsync(PROFILING_INSPECTOR_TIMEOUT_MS);
        await expect(operation).resolves.toBeUndefined();

        expect(flags.disconnectCount).toBe(1);
        expect(h.readdir()).toHaveLength(0);

        flags.releaseDeferred();
        await Promise.resolve();
        expect(flags.disconnectCount).toBe(1);
        expect(h.readdir()).toHaveLength(0);
        await expect(stopProfiling(scope)).resolves.toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('times out a withheld Profiler.stop callback and ignores its late profile', async () => {
    vi.useFakeTimers();
    try {
      const flags = h.installSyncFakeSession({
        deferMethod: 'Profiler.stop',
        profile: { nodes: [{ id: 1 }] },
      });
      const reserved = await startProfiling(scope, 'fit');
      expect(reserved?.status).toBe('reserved');

      const operation = stopProfiling(scope);
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(PROFILING_INSPECTOR_TIMEOUT_MS);
      await expect(operation).resolves.toBeUndefined();

      expect(flags.disconnectCount).toBe(1);
      expect(h.readdir()).toHaveLength(0);

      flags.releaseDeferred();
      await Promise.resolve();
      expect(flags.disconnectCount).toBe(1);
      expect(h.readdir()).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses the process-global active pointer when stop has no scope', async () => {
    h.installSyncFakeSession({ profile: { nodes: [] } });
    const previousCwd = process.cwd();
    process.chdir(h.tmp());
    try {
      await startProfiling(undefined, 'fit');
      await stopProfiling();
      expect(h.readdirHasCpuprofile()).toBe(true);
    } finally {
      process.chdir(previousCwd);
    }
  });

  it.each([
    ['Error', true, 'connect boom'],
    ['non-Error', 'non-error' as const, 'connect string boom'],
  ])('contains a %s connect failure', async (_kind, throwOnConnect, message) => {
    h.installSyncFakeSession({ throwOnConnect });
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    await expect(startProfiling(scope, 'fit')).resolves.toBeUndefined();

    expect(h.readdir()).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ evt: 'cli.profiling.start_failed', error: message }),
    );
    await expect(stopProfiling(scope)).resolves.toBeUndefined();
  });

  it.each([
    ['enable', { enableError: new Error('enable failed') }],
    ['start', { startError: new Error('start failed') }],
  ])(
    'contains a Profiler.%s callback failure and removes partial artifacts',
    async (_phase, opts) => {
      h.installSyncFakeSession(opts);
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

      await expect(startProfiling(scope, 'fit')).resolves.toBeUndefined();

      expect(h.readdir()).toHaveLength(0);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ evt: 'cli.profiling.start_failed' }),
      );
    },
  );

  it('swallows disconnect failure during successful cleanup', async () => {
    const flags = h.installSyncFakeSession({
      profile: { nodes: [] },
      throwOnDisconnect: true,
    });

    await startProfiling(scope, 'fit');
    await expect(stopProfiling(scope)).resolves.toBeDefined();
    expect(flags.disconnected).toBe(true);
    expect(flags.disconnectCount).toBe(1);
  });

  it.each([
    ['Error', 'error' as const, 'stop wire fault'],
    ['non-Error', 'non-error' as const, 'stop wire string fault'],
  ])('contains a %s Profiler.stop wire failure', async (_kind, throwOnStopPost, message) => {
    const flags = h.installSyncFakeSession({ throwOnStopPost });
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    await startProfiling(scope, 'fit');
    await expect(stopProfiling(scope)).resolves.toBeUndefined();

    expect(h.readdirHasLabels()).toBe(false);
    expect(h.readdirHasCpuprofile()).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ evt: 'cli.profiling.stop_failed', error: message }),
    );
    expect(flags.disconnected).toBe(true);
    expect(flags.disconnectCount).toBe(1);
  });

  it('publishes no pair when the CPU profile cannot be serialized', async () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    const flags = h.installSyncFakeSession({ profile: cyclic });

    await startProfiling(scope, 'fit');
    await expect(stopProfiling(scope)).resolves.toBeUndefined();

    expect(h.readdir()).toHaveLength(0);
    expect(flags.disconnectCount).toBe(1);
  });

  it('uses bounded unknown defaults when no scope or command is supplied', async () => {
    h.installSyncFakeSession({ profile: { nodes: [] } });
    const previousCwd = process.cwd();
    process.chdir(h.tmp());
    try {
      const artifacts = await startProfiling();
      expect(artifacts?.labels).toEqual({
        service: 'opensip-cli',
        runId: 'unknown',
        command: 'unknown',
      });
      expect(h.readdir().some((file) => file.includes('-unknown-unknown-'))).toBe(true);
      await stopProfiling();
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('resetProfilingForTests tears down an active profile and clears metadata', async () => {
    const flags = h.installSyncFakeSession({ profile: { nodes: [] } });
    await startProfiling(scope, 'fit');

    resetProfilingForTests();

    expect(flags.disconnected).toBe(true);
    expect(flags.disconnectCount).toBe(1);
    await expect(stopProfiling(scope)).resolves.toBeUndefined();
  });
});
