import { beforeEach, describe, expect, it, vi } from 'vitest';

import { graphCommandSpec } from '../graph/graph-command-spec.js';

import type { SignalEnvelope } from '@opensip-cli/contracts';
import type { ToolCliContext } from '@opensip-cli/core';

const h = vi.hoisted(() => ({
  executeGraph: vi.fn(),
  runHeapPreflight: vi.fn(async () => false),
}));

vi.mock('../graph.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../graph.js')>()),
  executeGraph: h.executeGraph,
}));

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
} {
  const deliverSignals = vi.fn(() => Promise.resolve());
  const maybeOpenReport = vi.fn(() => Promise.resolve());
  const ctx = {
    deliverSignals,
    maybeOpenReport,
    writeSarif: vi.fn(() => Promise.resolve()),
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
  return { ctx, deliverSignals, maybeOpenReport };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.executeGraph.mockResolvedValue({ envelope, session: { tool: 'graph', cwd: '/repo' } });
});

describe('graph --open report delivery', () => {
  it('calls the host report-open seam after a non-gate run', async () => {
    const { ctx, maybeOpenReport } = mockCli();

    await graphCommandSpec.handler({ cwd: '/repo', open: true, language: 'typescript' }, ctx);

    expect(h.executeGraph).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/repo', language: 'typescript' }),
      ctx,
    );
    expect(maybeOpenReport).toHaveBeenCalledWith({
      openRequested: true,
      jsonOutput: false,
    });
  });

  it('does not auto-open reports for gate modes', async () => {
    const { ctx, maybeOpenReport } = mockCli();

    await graphCommandSpec.handler(
      { cwd: '/repo', open: true, language: 'typescript', gateSave: true },
      ctx,
    );

    expect(maybeOpenReport).not.toHaveBeenCalled();
  });
});
