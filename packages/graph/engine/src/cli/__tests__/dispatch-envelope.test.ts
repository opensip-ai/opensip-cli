/**
 * ADR-0011 Phase 5 (supersedes the audit-P1-2 `graph-signal-emit` test):
 * `dispatchGraphResult` no longer emits cloud signals itself — the root owns
 * egress (`cli.deliverSignals`). Instead it RETURNS the run's envelope for
 * every mode that should deliver (gate / catalog / default render) and
 * `undefined` for plain `--json` (the `--workspace` child carrier, which must
 * not trigger per-child cloud emits). These tests pin that return contract.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { dispatchGraphResult } from '../graph.js';

import type { ToolCliContext } from '@opensip-cli/core';

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
    logger: console,
    scope: { signalSink: { emit: vi.fn() }, datastore: () => undefined },
  } as unknown as ToolCliContext;
}

const STARTED = '2026-06-03T00:00:00.000Z';

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => vi.restoreAllMocks());

describe('dispatchGraphResult — envelope return contract (ADR-0011)', () => {
  it('returns the envelope in --gate-save mode (root delivers it)', async () => {
    const opts = { gateSave: true, cwd: '/x' } as unknown as Parameters<
      typeof dispatchGraphResult
    >[0];
    const envelope = await dispatchGraphResult(opts, result, mockCli(), STARTED, '/x');
    expect(envelope?.tool).toBe('graph');
    expect(envelope?.schemaVersion).toBe(2);
  });

  it('returns the envelope in --catalog-output mode', async () => {
    // runCatalogJsonMode is mocked, so the path is never written — any
    // non-empty string exercises the branch.
    const opts = { catalogOutput: 'out/c.json', cwd: '/x' } as unknown as Parameters<
      typeof dispatchGraphResult
    >[0];
    const envelope = await dispatchGraphResult(opts, result, mockCli(), STARTED, '/x');
    expect(envelope?.tool).toBe('graph');
  });

  it('returns the envelope in the default render mode', async () => {
    const opts = { cwd: '/x' } as unknown as Parameters<typeof dispatchGraphResult>[0];
    const envelope = await dispatchGraphResult(opts, result, mockCli(), STARTED, '/x');
    expect(envelope?.tool).toBe('graph');
  });

  it('returns undefined under plain --json (the --workspace child carrier)', async () => {
    const opts = { json: true, cwd: '/x' } as unknown as Parameters<typeof dispatchGraphResult>[0];
    const cli = mockCli();
    const envelope = await dispatchGraphResult(opts, result, cli, STARTED, '/x');
    expect(envelope).toBeUndefined();
    // --json still emits the envelope to stdout via the seam.
    expect(cli.emitEnvelope).toHaveBeenCalledTimes(1);
  });
});
