/**
 * Coverage for sim's `--show` session-replay handler (`runSimShowMode`).
 *
 * Unlike `fit`, which exposes a dedicated `session show` command, `sim` wires
 * replay into its run command as a `--show <session>` flag handled inside
 * `tool.ts`. This drives that handler through the real `simSpec().handler`
 * entry point with a fake `ToolCliContext` whose scope carries a datastore.
 */

import { enterScope, RunScope, applyToolContributeScope } from '@opensip-cli/core';
import { DataStoreFactory } from '@opensip-cli/datastore';
import { SessionRepo } from '@opensip-cli/session-store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { simulationTool } from '../tool.js';

import type { StoredSession } from '@opensip-cli/contracts';
import type { CommandSpec, ToolCliContext } from '@opensip-cli/core';
import type { DataStore } from '@opensip-cli/datastore';

function simSpec(): CommandSpec<unknown, ToolCliContext> {
  const spec = simulationTool.commandSpecs?.[0];
  if (spec === undefined) throw new Error('simulationTool exposes no commandSpecs');
  return spec;
}

function simSession(overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    id: 'SIM_1',
    tool: 'sim',
    cwd: '/repo',
    startedAt: '2026-06-08T00:00:00.000Z',
    completedAt: '2026-06-08T00:00:00.000Z',
    score: 100,
    passed: true,
    durationMs: 5,
    payload: {
      summary: { total: 0, passed: 0, failed: 0, errors: 0, warnings: 0 },
      checks: [],
    },
    ...overrides,
  };
}

function makeContext(datastore: DataStore | undefined): {
  ctx: ToolCliContext;
  rendered: unknown[];
  emitted: unknown[];
  exitCodes: number[];
} {
  const rendered: unknown[] = [];
  const emitted: unknown[] = [];
  const exitCodes: number[] = [];
  const scope = new RunScope({ datastore: () => datastore });
  applyToolContributeScope(scope, simulationTool);
  const ctx: ToolCliContext = {
    scope,
    render: vi.fn((result: unknown) => {
      rendered.push(result);
      return Promise.resolve();
    }),
    registerLiveView: vi.fn(),
    renderLive: vi.fn(() => Promise.resolve()),
    maybeOpenReport: vi.fn(() => Promise.resolve()),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    setExitCode: (code: number) => {
      exitCodes.push(code);
    },
    emitJson: (value: unknown) => {
      emitted.push(value);
    },
    emitRaw: (value: unknown) => {
      emitted.push(value);
    },
    emitEnvelope: (value: unknown) => {
      emitted.push(value);
    },
    emitError: (detail: { message: string; exitCode: number; suggestion?: string }) => {
      exitCodes.push(detail.exitCode);
      emitted.push(detail);
    },
    reportFailure: vi.fn(() => Promise.resolve()),
    deliverSignals: () => Promise.resolve({ cloudAccepted: 0 }),
    writeSarif: () => Promise.resolve(),
    writeArtifact: () => Promise.resolve(),
    ensureArtifactDir: () => Promise.resolve(),
    saveBaseline: () => Promise.resolve(),
    compareBaseline: () =>
      Promise.resolve({
        added: [],
        resolved: [],
        unchanged: [],
        degraded: false,
      }),
    exportBaselineSarif: () => Promise.resolve(),
    exportBaselineFingerprints: () => Promise.resolve(),
    toolState: {
      get: () => Promise.resolve(undefined),
      put: () => Promise.resolve(),
      delete: () => Promise.resolve(),
      list: () => Promise.resolve([]),
    },
    runSession: {
      timing: {
        startedAt: new Date().toISOString(),
        startedAtEpochMs: Date.now(),
        elapsedMs: () => 0,
        snapshot: () => ({
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          durationMs: 0,
        }),
        complete: () => ({
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          durationMs: 0,
        }),
      },
    },
  };
  return { ctx, rendered, emitted, exitCodes };
}

let ds: DataStore;

beforeEach(() => {
  ds = DataStoreFactory.open({ backend: 'memory' });
  enterScope(new RunScope({ datastore: () => ds }));
});

afterEach(() => {
  ds.close();
});

describe('sim --show (runSimShowMode)', () => {
  it('replays a stored session by id and renders the result (non-JSON)', async () => {
    new SessionRepo(ds).save(simSession());
    const { ctx, rendered } = makeContext(ds);

    await simSpec().handler({ cwd: '/repo', show: 'SIM_1' }, ctx);

    expect(rendered).toHaveLength(1);
    // Replays render through the tool-agnostic session-replay view, not sim-done.
    expect(rendered[0]).toMatchObject({
      type: 'session-replay',
      session: { id: 'SIM_1', tool: 'sim' },
      envelope: { tool: 'sim' },
    });
  });

  it('emits a JSON replay wrapper when --json is passed', async () => {
    new SessionRepo(ds).save(simSession());
    const { ctx, emitted } = makeContext(ds);

    await simSpec().handler({ cwd: '/repo', show: 'SIM_1', json: true }, ctx);

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      session: { id: 'SIM_1', tool: 'sim' },
      fidelity: 'projection',
      envelope: { tool: 'sim', runId: 'SIM_1' },
    });
  });

  it('errors with datastore-unavailable when no datastore is present', async () => {
    const { ctx, emitted, exitCodes } = makeContext(undefined);

    await simSpec().handler({ cwd: '/repo', show: 'latest', json: true }, ctx);

    expect(exitCodes).toContain(2);
    expect(emitted[0]).toEqual({
      message: 'session replay requires a datastore',
      exitCode: 2,
      code: 'datastore-unavailable',
    });
  });

  it('errors (non-JSON) with a rendered error result when the session is missing', async () => {
    const { ctx, rendered, exitCodes } = makeContext(ds);

    await simSpec().handler({ cwd: '/repo', show: 'MISSING' }, ctx);

    expect(exitCodes).toContain(2);
    expect(rendered[0]).toMatchObject({ type: 'error' });
  });

  it('surfaces a decode-error when the stored payload is corrupt', async () => {
    new SessionRepo(ds).save(simSession({ id: 'SIM_BAD', payload: { not: 'valid' } }));
    const { ctx, emitted } = makeContext(ds);

    await simSpec().handler({ cwd: '/repo', show: 'SIM_BAD', json: true }, ctx);

    expect(emitted[0]).toMatchObject({ code: 'decode-error' });
  });
});
