/**
 * ADR-0011 Phase 5 (supersedes the audit-P1-2 `graph-signal-emit` test):
 * `dispatchGraphResult` returns truthful evidence independently of presentation
 * mode. Direct analyses carry both envelope + session. A `--workspace` child
 * carries only the envelope and performs no per-child egress. These tests pin
 * that return contract and exactly-once JSON delivery.
 *
 * host-owned-run-timing Phase 3: the host persists the returned session;
 * graph itself never writes the generic row.
 */

import { RunScope, runWithScope } from '@opensip-cli/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { dispatchGraphResult } from '../graph.js';

import type { Logger, ToolCliContext } from '@opensip-cli/core';

vi.mock('../graph-modes.js', () => ({
  runGateMode: vi.fn().mockResolvedValue(undefined),
  runCatalogJsonMode: vi.fn(),
}));

const result = { signals: [], catalog: undefined } as unknown as Parameters<
  typeof dispatchGraphResult
>[1];

function mockCli(): ToolCliContext {
  return {
    setExitCode: vi.fn(),
    emitRaw: vi.fn(),
    emitEnvelope: vi.fn(),
    emitError: vi.fn(),
    render: vi.fn(() => Promise.resolve()),
    deliverSignals: vi.fn(() => Promise.resolve({ delivered: false })),
    logger: console,
    scope: { signalSink: { emit: vi.fn() }, datastore: () => undefined },
    reportFailure: vi.fn(() => Promise.resolve()),
  } as unknown as ToolCliContext;
}

function completionLogger(): {
  readonly info: ReturnType<typeof vi.fn>;
  readonly scope: RunScope;
} {
  const info = vi.fn();
  const logger: Logger = {
    debug: vi.fn(),
    info,
    warn: vi.fn(),
    error: vi.fn(),
  };
  return { info, scope: new RunScope({ logger }) };
}

function completionEvents(info: ReturnType<typeof vi.fn>): readonly Record<string, unknown>[] {
  return info.mock.calls
    .map(([entry]) => entry as Record<string, unknown>)
    .filter((entry) => entry.evt === 'graph.cli.graph.complete');
}

const STARTED = '2026-06-03T00:00:00.000Z';

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => vi.restoreAllMocks());

describe('dispatchGraphResult — outcome return contract (ADR-0011)', () => {
  it('returns envelope + session in --gate-save mode', async () => {
    const opts = { gateSave: true, cwd: '/x' } as unknown as Parameters<
      typeof dispatchGraphResult
    >[0];
    const outcome = await dispatchGraphResult(opts, result, mockCli(), STARTED, '/x');
    expect(outcome?.kind).toBe('direct');
    expect(outcome?.envelope?.tool).toBe('graph');
    expect(outcome?.envelope?.schemaVersion).toBe(2);
    expect(outcome?.session?.tool).toBe('graph');
  });

  it('returns envelope + session in --catalog-output mode', async () => {
    // runCatalogJsonMode is mocked, so the path is never written — any
    // non-empty string exercises the branch.
    const opts = {
      catalogOutput: 'out/c.json',
      cwd: '/x',
    } as unknown as Parameters<typeof dispatchGraphResult>[0];
    const outcome = await dispatchGraphResult(opts, result, mockCli(), STARTED, '/x');
    expect(outcome?.kind).toBe('direct');
    expect(outcome?.envelope?.tool).toBe('graph');
    expect(outcome?.session?.tool).toBe('graph');
  });

  it('returns the envelope AND a session in the default render mode', async () => {
    const opts = { cwd: '/x' } as unknown as Parameters<typeof dispatchGraphResult>[0];
    const outcome = await dispatchGraphResult(opts, result, mockCli(), STARTED, '/x');
    expect(outcome?.kind).toBe('direct');
    expect(outcome?.envelope?.tool).toBe('graph');
    // host-owned-run-timing Phase 3: the human-render path contributes the
    // session the host persists; timing/id are host-stamped (absent here).
    expect(outcome?.session?.tool).toBe('graph');
    expect(outcome?.session?.cwd).toBe('/x');
    expect(outcome?.session?.payload).toBeDefined();
  });

  it('returns envelope + session under direct --json while delivering/emitting exactly once', async () => {
    const opts = { json: true, cwd: '/x' } as unknown as Parameters<typeof dispatchGraphResult>[0];
    const cli = mockCli();
    const outcome = await dispatchGraphResult(opts, result, cli, STARTED, '/x');
    expect(outcome?.kind).toBe('direct');
    expect(outcome?.envelope?.tool).toBe('graph');
    expect(outcome?.session?.tool).toBe('graph');
    // --json first delivers the unfiltered envelope so the host-owned findings
    // exit is decided before stdout JSON emission, then emits the envelope.
    expect(cli.deliverSignals).toHaveBeenCalledTimes(1);
    expect(cli.emitEnvelope).toHaveBeenCalledTimes(1);
  });

  it('returns the same complete direct evidence when JSON also has a side artifact', async () => {
    const opts = {
      json: true,
      cwd: '/x',
    } as unknown as Parameters<typeof dispatchGraphResult>[0];
    const cli = mockCli();
    const outcome = await dispatchGraphResult(opts, result, cli, STARTED, '/x');
    expect(outcome?.kind).toBe('direct');
    expect(outcome?.envelope?.tool).toBe('graph');
    expect(outcome?.session?.tool).toBe('graph');
    expect(cli.deliverSignals).toHaveBeenCalledTimes(1);
    expect(cli.emitEnvelope).toHaveBeenCalledTimes(1);
  });

  it('suppresses inline delivery for a --workspace child (still emits, no egress/verdict exit)', async () => {
    const prior = process.env.OPENSIP_GRAPH_WORKSPACE_CHILD;
    process.env.OPENSIP_GRAPH_WORKSPACE_CHILD = '1';
    try {
      const opts = { json: true, cwd: '/x' } as unknown as Parameters<
        typeof dispatchGraphResult
      >[0];
      const cli = mockCli();
      const { info, scope } = completionLogger();
      const outcome = await runWithScope(scope, () =>
        dispatchGraphResult(opts, result, cli, STARTED, '/x'),
      );
      expect(outcome?.kind).toBe('workspace-child');
      expect(outcome?.envelope?.tool).toBe('graph');
      expect(outcome?.session).toBeUndefined();
      // The parent owns the aggregate (audit P1-2): the child must NOT deliver
      // (no per-unit cloud egress, no per-verdict exit) but still emits its JSON
      // so the parent can parse per-unit signals from stdout.
      expect(cli.deliverSignals).not.toHaveBeenCalled();
      expect(cli.emitEnvelope).toHaveBeenCalledTimes(1);
      const events = completionEvents(info);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        deliveryMode: 'json',
        sessionContributed: false,
        envelopeReturned: true,
        workspaceChild: true,
      });
    } finally {
      if (prior === undefined) delete process.env.OPENSIP_GRAPH_WORKSPACE_CHILD;
      else process.env.OPENSIP_GRAPH_WORKSPACE_CHILD = prior;
    }
  });

  it('returns envelope + session for --report-to without delivering inside dispatch', async () => {
    const opts = {
      reportTo: 'https://example.invalid/receiver',
      cwd: '/x',
    } as unknown as Parameters<typeof dispatchGraphResult>[0];
    const cli = mockCli();
    const outcome = await dispatchGraphResult(opts, result, cli, STARTED, '/x');

    expect(outcome?.kind).toBe('direct');
    expect(outcome?.envelope?.tool).toBe('graph');
    expect(outcome?.session?.tool).toBe('graph');
    // Non-JSON egress remains composition-root-owned.
    expect(cli.deliverSignals).not.toHaveBeenCalled();
  });

  it.each([
    ['gate', { gateSave: true }, 'gate'],
    ['catalog', { catalogOutput: 'out/c.json' }, 'catalog'],
    ['JSON', { json: true }, 'json'],
    ['human', {}, 'human'],
    ['report-to', { reportTo: 'https://example.invalid/receiver' }, 'report-to'],
  ] as const)(
    'logs stable payload-free completion evidence for %s delivery',
    async (_label, modeOptions, deliveryMode) => {
      const cli = mockCli();
      const { info, scope } = completionLogger();
      const opts = {
        cwd: '/x',
        ...modeOptions,
      } as unknown as Parameters<typeof dispatchGraphResult>[0];

      await runWithScope(scope, () =>
        dispatchGraphResult(opts, result, cli, STARTED, '/x'),
      );

      const events = completionEvents(info);
      expect(events).toHaveLength(1);
      const event = events[0];
      expect(event).toMatchObject({
        deliveryMode,
        sessionContributed: true,
        envelopeReturned: true,
        workspaceChild: false,
      });
      expect(event).not.toHaveProperty('payload');
      expect(event).not.toHaveProperty('session');
      expect(event).not.toHaveProperty('envelope');
    },
  );
});
