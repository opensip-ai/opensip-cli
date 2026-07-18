import { beforeEach, describe, expect, it, vi } from 'vitest';

import { graphCommandSpec } from '../graph/graph-command-spec.js';

import type { SignalEnvelope } from '@opensip-cli/contracts';
import type { ToolCliContext } from '@opensip-cli/core';

const h = vi.hoisted(() => ({
  executeGraph: vi.fn(),
  runHeapPreflight: vi.fn((): Promise<false | { readonly startedAt: string }> =>
    Promise.resolve(false),
  ),
}));

vi.mock('../graph.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    executeGraph: h.executeGraph,
  };
});

vi.mock('../heap-preflight.js', () => ({
  runHeapPreflight: h.runHeapPreflight,
}));

const envelope = {
  tool: 'graph',
  schemaVersion: 2,
  runId: 'RUN_1',
  signals: [],
} as unknown as SignalEnvelope;

function mockCli(): {
  ctx: ToolCliContext;
  deliverSignals: ReturnType<typeof vi.fn>;
  maybeOpenReport: ReturnType<typeof vi.fn>;
  writeSarif: ReturnType<typeof vi.fn>;
} {
  const deliverSignals = vi.fn(() => Promise.resolve());
  const maybeOpenReport = vi.fn(() => Promise.resolve());
  const writeSarif = vi.fn(() => Promise.resolve());
  const ctx = {
    deliverSignals,
    maybeOpenReport,
    writeSarif,
    setExitCode: vi.fn(),
    registerLiveView: vi.fn(),
    renderLive: vi.fn(() => Promise.resolve()),
    render: vi.fn(() => Promise.resolve()),
    emitJson: vi.fn(),
    emitRaw: vi.fn(),
    emitEnvelope: vi.fn(),
    emitError: vi.fn(),
    reportFailure: vi.fn(() => Promise.resolve()),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    scope: { datastore: () => undefined },
  } as unknown as ToolCliContext;
  return { ctx, deliverSignals, maybeOpenReport, writeSarif };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.runHeapPreflight.mockResolvedValue(false);
  h.executeGraph.mockResolvedValue({
    kind: 'direct',
    envelope,
    session: { tool: 'graph', cwd: '/repo' },
  });
});

describe('graph --open report delivery', () => {
  it('returns a delegated completion when the heap-preflight child ran the command', async () => {
    const { ctx, maybeOpenReport } = mockCli();
    h.runHeapPreflight.mockResolvedValueOnce({ startedAt: '2026-07-09T23:22:19.000Z' });

    const completion = await graphCommandSpec.handler({ cwd: '/repo' }, ctx);

    expect(completion).toEqual({
      execution: { kind: 'delegated', startedAt: '2026-07-09T23:22:19.000Z' },
    });
    expect(h.executeGraph).not.toHaveBeenCalled();
    expect(maybeOpenReport).not.toHaveBeenCalled();
  });

  it('calls the host report-open seam after a non-gate run', async () => {
    const { ctx, deliverSignals, maybeOpenReport } = mockCli();

    const completion = await graphCommandSpec.handler(
      { cwd: '/repo', open: true, language: 'typescript' },
      ctx,
    );

    expect(h.executeGraph).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/repo', language: 'typescript' }),
      ctx,
    );
    expect(maybeOpenReport).toHaveBeenCalledWith({
      openRequested: true,
      jsonOutput: false,
    });
    expect(completion).toEqual({
      envelope,
      session: { tool: 'graph', cwd: '/repo' },
    });
    expect(deliverSignals).toHaveBeenCalledTimes(1);
  });

  it('does not auto-open reports for gate modes', async () => {
    const { ctx, deliverSignals, maybeOpenReport } = mockCli();

    await graphCommandSpec.handler(
      { cwd: '/repo', open: true, language: 'typescript', gateSave: true },
      ctx,
    );

    expect(maybeOpenReport).not.toHaveBeenCalled();
    // Gate delivery is owned inside executeGraph/runGateMode.
    expect(deliverSignals).not.toHaveBeenCalled();
  });

  it('retains JSON output for --sarif and writes the side artifact exactly once', async () => {
    const { ctx, deliverSignals, maybeOpenReport, writeSarif } = mockCli();

    const completion = await graphCommandSpec.handler(
      { cwd: '/repo', json: true, sarif: '/repo/graph.sarif' },
      ctx,
    );

    expect(h.executeGraph).toHaveBeenCalledWith(expect.objectContaining({ json: true }), ctx);
    expect(writeSarif).toHaveBeenCalledTimes(1);
    expect(writeSarif).toHaveBeenCalledWith(envelope, '/repo/graph.sarif');
    // executeGraph's JSON renderer owns signal delivery; the root must not
    // deliver the returned evidence a second time.
    expect(deliverSignals).not.toHaveBeenCalled();
    expect(maybeOpenReport).not.toHaveBeenCalled();
    expect(completion).toEqual({
      envelope,
      session: { tool: 'graph', cwd: '/repo' },
    });
  });

  it('delivers report-to exactly once at the composition root and preserves both evidence forms', async () => {
    const { ctx, deliverSignals } = mockCli();

    const completion = await graphCommandSpec.handler(
      {
        cwd: '/repo',
        reportTo: 'https://receiver.example.test/graph',
        apiKey: 'test-api-key',
        language: 'typescript',
      },
      ctx,
    );

    expect(deliverSignals).toHaveBeenCalledTimes(1);
    expect(deliverSignals).toHaveBeenCalledWith(envelope, {
      cwd: '/repo',
      reportTo: 'https://receiver.example.test/graph',
      apiKey: 'test-api-key',
    });
    expect(completion).toEqual({
      envelope,
      session: { tool: 'graph', cwd: '/repo' },
    });
  });

  it('preserves a workspace parent aggregate session without inventing an envelope', async () => {
    const { ctx, deliverSignals } = mockCli();
    h.executeGraph.mockResolvedValueOnce({
      kind: 'workspace-parent',
      session: { tool: 'graph', cwd: '/repo' },
    });

    const completion = await graphCommandSpec.handler(
      { cwd: '/repo', workspace: true, json: true },
      ctx,
    );

    expect(completion).toEqual({ session: { tool: 'graph', cwd: '/repo' } });
    expect(deliverSignals).not.toHaveBeenCalled();
  });

  it('preserves a workspace child envelope without a session or duplicate egress', async () => {
    const prior = process.env.OPENSIP_GRAPH_WORKSPACE_CHILD;
    process.env.OPENSIP_GRAPH_WORKSPACE_CHILD = '1';
    try {
      const { ctx, deliverSignals } = mockCli();
      h.executeGraph.mockResolvedValueOnce({ kind: 'workspace-child', envelope });

      const completion = await graphCommandSpec.handler(
        { cwd: '/repo', json: true, language: 'typescript' },
        ctx,
      );

      expect(completion).toEqual({ envelope });
      expect(deliverSignals).not.toHaveBeenCalled();
    } finally {
      if (prior === undefined) delete process.env.OPENSIP_GRAPH_WORKSPACE_CHILD;
      else process.env.OPENSIP_GRAPH_WORKSPACE_CHILD = prior;
    }
  });
});
