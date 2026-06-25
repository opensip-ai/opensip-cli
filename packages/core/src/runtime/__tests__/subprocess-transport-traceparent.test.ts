/**
 * TRACEPARENT propagation on the bundled live-run fork path (spec 01 / OQ6).
 */

import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

const mockCurrentTraceparent = vi.fn<() => string | undefined>();

vi.mock('../../lib/telemetry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/telemetry.js')>();
  return {
    ...actual,
    currentTraceparent: () => mockCurrentTraceparent(),
  };
});

const FIXTURE = fileURLToPath(new URL('fixtures/progress-worker.mjs', import.meta.url));

async function forkTraceparentEcho(): Promise<string | undefined> {
  const { createSubprocessProgressRun } = await import('../subprocess-transport.js');
  const run = createSubprocessProgressRun<number, string | undefined>({
    command: FIXTURE,
    argv: ['traceparent-echo'],
  });
  return run.result;
}

describe('TRACEPARENT propagation (createSubprocessProgressRun)', () => {
  afterEach(() => {
    mockCurrentTraceparent.mockReset();
    vi.resetModules();
  });

  it('injects TRACEPARENT into the child env when a recording span is active', async () => {
    mockCurrentTraceparent.mockReturnValue('00-abc-def-01');
    expect(await forkTraceparentEcho()).toBe('00-abc-def-01');
  });

  it('omits TRACEPARENT from the child env when no recording span is active', async () => {
    mockCurrentTraceparent.mockReturnValue(undefined);
    expect(await forkTraceparentEcho()).toBeUndefined();
  });
});
