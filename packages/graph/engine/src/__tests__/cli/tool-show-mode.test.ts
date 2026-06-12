/**
 * Coverage for graph's `--show` session-replay handler (`runGraphShowMode`).
 *
 * Like `sim`, `graph` wires replay into its run command as a `--show <session>`
 * flag handled inside `graph-command-spec.ts`. This drives that handler through
 * the real `graphCommandSpec.handler` with a fake `ToolCliContext` whose scope
 * carries a datastore.
 */

import { DataStoreFactory } from '@opensip-cli/datastore';
import { SessionRepo } from '@opensip-cli/session-store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { graphCommandSpec } from '../../cli/graph/graph-command-spec.js';

import type { StoredSession } from '@opensip-cli/contracts';
import type { ToolCliContext } from '@opensip-cli/core';
import type { DataStore } from '@opensip-cli/datastore';

function graphSession(overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    id: 'GRAPH_1',
    tool: 'graph',
    cwd: '/repo',
    timestamp: '2026-06-08T00:00:00.000Z',
    score: 80,
    passed: false,
    durationMs: 12,
    payload: {
      summary: { total: 1, passed: 0, failed: 1, errors: 1, warnings: 0 },
      checks: [
        {
          checkSlug: 'graph:god-file',
          passed: false,
          violationCount: 1,
          durationMs: 0,
          findings: [
            { ruleId: 'graph:god-file', message: 'too big', severity: 'error', filePath: 'a.ts' },
          ],
        },
      ],
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
  const ctx = {
    scope: { datastore: () => datastore },
    render: vi.fn((result: unknown) => {
      rendered.push(result);
      return Promise.resolve();
    }),
    registerLiveView: vi.fn(),
    renderLive: vi.fn(() => Promise.resolve()),
    maybeOpenDashboard: vi.fn(() => Promise.resolve()),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    setExitCode: (code: number) => {
      exitCodes.push(code);
    },
    emitJson: (value: unknown) => {
      emitted.push(value);
    },
    emitEnvelope: (value: unknown) => {
      emitted.push(value);
    },
    emitError: (detail: { message: string; exitCode: number; code?: string }) => {
      exitCodes.push(detail.exitCode);
      emitted.push(detail);
    },
    deliverSignals: () => Promise.resolve(),
    writeSarif: () => Promise.resolve(),
  } as unknown as ToolCliContext;
  return { ctx, rendered, emitted, exitCodes };
}

let ds: DataStore;

beforeEach(() => {
  ds = DataStoreFactory.open({ backend: 'memory' });
});

afterEach(() => {
  ds.close();
});

describe('graph --show (runGraphShowMode)', () => {
  it('replays a stored session by id and renders the result (non-JSON)', async () => {
    new SessionRepo(ds).save(graphSession());
    const { ctx, rendered } = makeContext(ds);

    await graphCommandSpec.handler({ cwd: '/repo', show: 'GRAPH_1' }, ctx);

    expect(rendered).toHaveLength(1);
    // Replays render through the tool-agnostic session-replay view (not the live
    // graph-done view) — uniform across tools, envelope-driven, no live footer.
    expect(rendered[0]).toMatchObject({
      type: 'session-replay',
      session: { id: 'GRAPH_1', tool: 'graph' },
      envelope: { tool: 'graph' },
    });
  });

  it('emits a JSON replay wrapper when --json is passed', async () => {
    new SessionRepo(ds).save(graphSession());
    const { ctx, emitted } = makeContext(ds);

    await graphCommandSpec.handler({ cwd: '/repo', show: 'GRAPH_1', json: true }, ctx);

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      session: { id: 'GRAPH_1', tool: 'graph' },
      fidelity: 'projection',
      envelope: { tool: 'graph', runId: 'GRAPH_1' },
    });
  });

  it('errors with datastore-unavailable when no datastore is present', async () => {
    const { ctx, emitted, exitCodes } = makeContext(undefined);

    await graphCommandSpec.handler({ cwd: '/repo', show: 'latest', json: true }, ctx);

    expect(exitCodes).toContain(2);
    expect(emitted[0]).toEqual({
      message: 'session replay requires a datastore',
      exitCode: 2,
      code: 'datastore-unavailable',
    });
  });

  it('errors (non-JSON) with a rendered error result when the session is missing', async () => {
    const { ctx, rendered, exitCodes } = makeContext(ds);

    await graphCommandSpec.handler({ cwd: '/repo', show: 'MISSING' }, ctx);

    expect(exitCodes).toContain(2);
    expect(rendered[0]).toMatchObject({ type: 'error' });
  });

  it('surfaces a decode-error when the stored payload is corrupt', async () => {
    new SessionRepo(ds).save(graphSession({ id: 'GRAPH_BAD', payload: { not: 'valid' } }));
    const { ctx, emitted } = makeContext(ds);

    await graphCommandSpec.handler({ cwd: '/repo', show: 'GRAPH_BAD', json: true }, ctx);

    expect(emitted[0]).toMatchObject({ code: 'decode-error' });
  });
});
