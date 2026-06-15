/**
 * ADR-0011 Phase 5 (supersedes the audit-P1-2 `graph-signal-emit` test):
 * `dispatchGraphResult` no longer emits cloud signals itself — the root owns
 * egress (`cli.deliverSignals`). Instead it RETURNS the run's
 * {@link GraphRunOutcome} (envelope + optional session) for every mode that
 * should deliver (gate / catalog / default render) and `undefined` for plain
 * `--json` (the `--workspace` child carrier, which must not trigger per-child
 * cloud emits). These tests pin that return contract.
 *
 * host-owned-run-timing Phase 3: the human-render path's outcome also carries a
 * `session` contribution (the host persists it); the export modes (gate /
 * catalog / `--json` / `--report-to`) carry no `session`.
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

describe('dispatchGraphResult — outcome return contract (ADR-0011)', () => {
  it('returns the envelope (no session) in --gate-save mode (root delivers it)', async () => {
    const opts = { gateSave: true, cwd: '/x' } as unknown as Parameters<
      typeof dispatchGraphResult
    >[0];
    const outcome = await dispatchGraphResult(opts, result, mockCli(), STARTED, '/x');
    expect(outcome?.envelope?.tool).toBe('graph');
    expect(outcome?.envelope?.schemaVersion).toBe(2);
    // Export mode: the host must NOT persist a session for the gate path.
    expect(outcome?.session).toBeUndefined();
  });

  it('returns the envelope (no session) in --catalog-output mode', async () => {
    // runCatalogJsonMode is mocked, so the path is never written — any
    // non-empty string exercises the branch.
    const opts = { catalogOutput: 'out/c.json', cwd: '/x' } as unknown as Parameters<
      typeof dispatchGraphResult
    >[0];
    const outcome = await dispatchGraphResult(opts, result, mockCli(), STARTED, '/x');
    expect(outcome?.envelope?.tool).toBe('graph');
    expect(outcome?.session).toBeUndefined();
  });

  it('returns the envelope AND a session in the default render mode', async () => {
    const opts = { cwd: '/x' } as unknown as Parameters<typeof dispatchGraphResult>[0];
    const outcome = await dispatchGraphResult(opts, result, mockCli(), STARTED, '/x');
    expect(outcome?.envelope?.tool).toBe('graph');
    // host-owned-run-timing Phase 3: the human-render path contributes the
    // session the host persists; timing/id are host-stamped (absent here).
    expect(outcome?.session?.tool).toBe('graph');
    expect(outcome?.session?.cwd).toBe('/x');
    expect(outcome?.session?.payload).toBeDefined();
  });

  it('returns undefined under plain --json (the --workspace child carrier)', async () => {
    const opts = { json: true, cwd: '/x' } as unknown as Parameters<typeof dispatchGraphResult>[0];
    const cli = mockCli();
    const outcome = await dispatchGraphResult(opts, result, cli, STARTED, '/x');
    expect(outcome).toBeUndefined();
    // --json still emits the envelope to stdout via the seam.
    expect(cli.emitEnvelope).toHaveBeenCalledTimes(1);
  });
});
