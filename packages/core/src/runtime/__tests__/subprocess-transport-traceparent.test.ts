/**
 * TRACEPARENT propagation on the bundled live-run fork path (spec 01 / OQ6).
 */

import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type * as Telemetry from '../../lib/telemetry.js';

const mockCurrentTraceparent = vi.fn<() => string | undefined>();

vi.mock('../../lib/telemetry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof Telemetry>();
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

  it('strips an ambient TRACEPARENT already present in this process env when no span is active', async () => {
    // Reproduces deterministically regardless of the host's own ambient env
    // (e.g. an external OTel-instrumented launcher/CI runner that sets
    // TRACEPARENT on this very process): buildChildEnv used to only ever
    // ADD a TRACEPARENT key when a span was active, never strip one already
    // inherited from `parentEnv` — so a stale ambient value passed straight
    // through to the child instead of being omitted.
    const previous = process.env.TRACEPARENT;
    process.env.TRACEPARENT = '00-stale-ambient-trace-01';
    try {
      mockCurrentTraceparent.mockReturnValue(undefined);
      expect(await forkTraceparentEcho()).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.TRACEPARENT;
      else process.env.TRACEPARENT = previous;
    }
  });
});
