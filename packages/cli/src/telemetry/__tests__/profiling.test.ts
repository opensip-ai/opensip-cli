/**
 * Optional local CPU profiling — explicit gate, scoped lifecycle, and shutdown.
 *
 * Every gate-open test injects the synchronous fake inspector. The genuine
 * process-global profiler remains isolated in profiling-real-inspector.e2e.test.ts
 * so it cannot corrupt Vitest's inspector-based coverage collection.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { isProfilingEnabled, startProfiling, stopProfiling } from '../profiling.js';
import { shutdownTelemetry } from '../sdk-init.js';

import {
  createProfilingHarness,
  ENDPOINT,
  GATE,
  PROFILE_DIR,
} from './fixtures/profiling-test-harness.js';

const h = createProfilingHarness();

describe('isProfilingEnabled', () => {
  it('is false when profiling is unset, including when an OTLP endpoint is present', () => {
    expect(isProfilingEnabled()).toBe(false);
    process.env[ENDPOINT] = 'http://localhost:4318/v1/traces';
    expect(isProfilingEnabled()).toBe(false);
  });

  it('is true for explicit 1/true without requiring an OTLP endpoint', () => {
    process.env[GATE] = '1';
    expect(isProfilingEnabled()).toBe(true);
    process.env[GATE] = ' TRUE ';
    expect(isProfilingEnabled()).toBe(true);
  });

  it('keeps explicit 0/false and unknown values off with or without an endpoint', () => {
    process.env[ENDPOINT] = 'http://localhost:4318/v1/traces';
    for (const value of ['0', 'false', 'yes', '']) {
      process.env[GATE] = value;
      expect(isProfilingEnabled()).toBe(false);
    }
  });
});

describe('startProfiling / stopProfiling', () => {
  it('is a no-op when the explicit gate is closed', async () => {
    process.env[ENDPOINT] = 'http://localhost:4318/v1/traces';
    await expect(startProfiling(h.scopeFor(), 'fit')).resolves.toBeUndefined();
    expect(h.profilesDirExists()).toBe(false);
  });

  it('profiles locally without OTLP and returns metadata rather than profile content', async () => {
    process.env[GATE] = '1';
    h.installSyncFakeSession({ profile: { nodes: [{ id: 1 }] } });
    const scope = h.scopeFor();

    const started = await startProfiling(scope, 'fit:run');
    expect(started).toEqual(
      expect.objectContaining({
        profilePath: expect.stringMatching(/\.cpuprofile$/),
        labelsPath: expect.stringMatching(/\.labels\.json$/),
        labels: { service: 'opensip-cli', runId: 'RUN_PROF_1', command: 'fit:run' },
        status: 'reserved',
      }),
    );
    expect(started).not.toHaveProperty('profile');
    expect((scope.telemetry.profiling as { artifacts?: unknown } | undefined)?.artifacts).toBe(
      started,
    );

    const stopped = await stopProfiling(scope);
    expect(stopped).not.toBe(started);
    expect(stopped).toMatchObject({
      profilePath: started?.profilePath,
      labelsPath: started?.labelsPath,
      status: 'complete',
      completedAt: expect.any(String),
    });
    expect((scope.telemetry.profiling as { artifacts?: unknown } | undefined)?.artifacts).toBe(
      stopped,
    );
    expect(h.readdirHasLabels()).toBe(true);
    expect(h.readdirHasCpuprofile()).toBe(true);
  });

  it('reuses one in-flight state and makes an immediate stop wait for start', async () => {
    process.env[GATE] = '1';
    const flags = h.installSyncFakeSession({
      deferMethod: 'Profiler.start',
      profile: { nodes: [] },
    });
    const scope = h.scopeFor();
    const concurrentScope = h.scopeFor();

    const firstStart = startProfiling(scope, 'fit');
    const secondStart = startProfiling(concurrentScope, 'graph');
    const stop = stopProfiling(concurrentScope);
    const secondStop = stopProfiling(scope);

    expect(secondStart).toBe(firstStart);
    expect(secondStop).toBe(stop);
    await Promise.resolve();
    expect(h.readdirHasLabels()).toBe(true);
    expect(h.readdirHasCpuprofile()).toBe(false);
    flags.releaseDeferred();

    const [first, second, stopped] = await Promise.all([firstStart, secondStart, stop]);
    expect(second).toBe(first);
    expect(first?.status).toBe('reserved');
    expect(stopped).not.toBe(first);
    expect(stopped).toMatchObject({
      profilePath: first?.profilePath,
      labelsPath: first?.labelsPath,
      status: 'complete',
    });
    expect(flags.disconnectCount).toBe(1);
    expect(h.readdir().filter((file) => file.endsWith('.labels.json'))).toHaveLength(1);
    expect(h.readdir().filter((file) => file.endsWith('.cpuprofile'))).toHaveLength(1);
  });

  it('honors a caller-selected OPENSIP_PROFILE_DIR', async () => {
    process.env[GATE] = '1';
    process.env[PROFILE_DIR] = join(h.tmp(), 'caller', 'profiles');
    h.installSyncFakeSession({ profile: { nodes: [] } });

    const artifacts = await startProfiling(h.scopeFor(), 'graph');
    await stopProfiling();

    expect(artifacts?.profilePath.startsWith(process.env[PROFILE_DIR])).toBe(true);
    expect(h.readdirHasLabels()).toBe(true);
    expect(h.readdirHasCpuprofile()).toBe(true);
  });

  it('shutdownTelemetry flushes a profile even when no OTel provider was started', async () => {
    process.env[GATE] = '1';
    h.installSyncFakeSession({ profile: { nodes: [] } });

    await startProfiling(h.scopeFor(), 'fit');
    await shutdownTelemetry();

    expect(h.readdirHasCpuprofile()).toBe(true);
  });

  it('stopProfiling when idle is safe and preserves the last metadata', async () => {
    await expect(stopProfiling()).resolves.toBeUndefined();

    process.env[GATE] = '1';
    h.installSyncFakeSession({ profile: { nodes: [] } });
    const scope = h.scopeFor();
    const artifacts = await startProfiling(scope, 'fit');
    const completed = await stopProfiling(scope);

    expect(completed?.status).toBe('complete');
    await expect(stopProfiling(scope)).resolves.toBe(completed);
    const labels = JSON.parse(readFileSync(artifacts?.labelsPath ?? '', 'utf8')) as Record<
      string,
      unknown
    >;
    expect(labels).toEqual({ service: 'opensip-cli', runId: 'RUN_PROF_1', command: 'fit' });
  });
});
