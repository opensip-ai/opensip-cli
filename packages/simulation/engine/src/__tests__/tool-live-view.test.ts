/* eslint-disable sonarjs/deprecation -- exercises the deprecated-but-supported Tool.register() contract through 2.x (removed in 3.0.0; fit/graph/sim migrate to commandSpecs in release 2.11.0 Phases 3-5). The register() path is sanctioned until then, so these tests must access it. */
/**
 * @fileoverview Tests for simulationTool's live-view wiring (ADR-0016) — the
 * paths the static-render tool.test.ts can't reach:
 *
 *   - register() contributes a live view under the `sim` key, and that
 *     callback renders the live view then delivers the returned envelope to the
 *     composition root (cloud + --report-to egress).
 *   - the interactive TTY action branch routes to cli.renderLive +
 *     maybeOpenDashboard instead of the static executeSim path.
 *
 * `renderSimLive` is mocked so we exercise the tool's wiring without spinning
 * up a real Ink render host.
 */

import { enterScope, RunScope } from '@opensip-tools/core';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { simulationTool } from '../tool.js';

import type { SignalEnvelope } from '@opensip-tools/contracts';
import type { ToolCliContext } from '@opensip-tools/core';

// Mock the Ink renderer so register()'s live-view callback can run without a
// real terminal. The mock returns a deterministic envelope.
const fakeEnvelope = {
  schemaVersion: 2,
  tool: 'sim',
  verdict: { passed: false, summary: { passed: 0, failed: 1, errors: 0, warnings: 0 } },
} as unknown as SignalEnvelope;

vi.mock('../cli/sim-runner.js', () => ({
  renderSimLive: vi.fn(() => Promise.resolve(fakeEnvelope)),
}));

const { renderSimLive } = await import('../cli/sim-runner.js');

beforeEach(() => {
  const scope = new RunScope();
  Object.assign(scope, simulationTool.contributeScope?.() ?? {});
  enterScope(scope);
});

afterEach(() => {
  vi.clearAllMocks();
});

interface Captured {
  ctx: ToolCliContext;
  liveViews: Map<string, (args: unknown) => Promise<void>>;
  delivered: { envelope: SignalEnvelope; opts: unknown }[];
  renderLiveCalls: [string, unknown][];
  dashboardCalls: unknown[];
  exitCodes: number[];
}

function makeCtx(program: Command): Captured {
  const liveViews = new Map<string, (args: unknown) => Promise<void>>();
  const delivered: Captured['delivered'] = [];
  const renderLiveCalls: Captured['renderLiveCalls'] = [];
  const dashboardCalls: unknown[] = [];
  const exitCodes: number[] = [];
  const ctx = {
    program,
    scope: new RunScope(),
    render: vi.fn(() => Promise.resolve()),
    registerLiveView: vi.fn((key: string, cb: (args: unknown) => Promise<void>) => {
      liveViews.set(key, cb);
    }),
    renderLive: vi.fn((key: string, args: unknown) => {
      renderLiveCalls.push([key, args]);
      return Promise.resolve();
    }),
    maybeOpenDashboard: vi.fn((arg: unknown) => {
      dashboardCalls.push(arg);
      return Promise.resolve();
    }),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    setExitCode: (code: number) => exitCodes.push(code),
    emitJson: vi.fn(),
    emitEnvelope: vi.fn(),
    deliverSignals: vi.fn((envelope: SignalEnvelope, opts: unknown) => {
      delivered.push({ envelope, opts });
      return Promise.resolve();
    }),
    writeSarif: vi.fn(() => Promise.resolve()),
  } as unknown as ToolCliContext;
  return { ctx, liveViews, delivered, renderLiveCalls, dashboardCalls, exitCodes };
}

describe('simulationTool live-view callback (ADR-0016)', () => {
  it('registers a live view under the `sim` key and delivers the rendered envelope', async () => {
    const program = new Command();
    program.exitOverride();
    const cap = makeCtx(program);

    simulationTool.register!(cap.ctx);

    const callback = cap.liveViews.get('sim');
    expect(callback).toBeDefined();

    // Invoke the live-view callback the dispatcher would call.
    await callback?.({ cwd: '/proj', reportTo: 'https://cloud.example', apiKey: 'k' });

    // The Ink renderer ran with setExitCode wired through.
    expect(renderSimLive).toHaveBeenCalledTimes(1);
    // The returned envelope was delivered to the composition root with egress
    // options derived from the args; a failing run marks runFailed=true.
    expect(cap.delivered).toHaveLength(1);
    expect(cap.delivered[0]?.envelope).toBe(fakeEnvelope);
    expect(cap.delivered[0]?.opts).toMatchObject({
      cwd: '/proj',
      reportTo: 'https://cloud.example',
      apiKey: 'k',
      runFailed: true,
    });
  });

  it('does not deliver when the renderer returns no envelope', async () => {
    (renderSimLive as unknown as { mockResolvedValueOnce: (v: unknown) => void })
      .mockResolvedValueOnce(undefined);
    const program = new Command();
    program.exitOverride();
    const cap = makeCtx(program);
    simulationTool.register!(cap.ctx);

    await cap.liveViews.get('sim')?.({ cwd: '/proj' });

    expect(cap.delivered).toHaveLength(0);
  });
});

describe('simulationTool action — interactive TTY branch', () => {
  const originalIsTTY = process.stdout.isTTY;

  afterEach(() => {
    process.stdout.isTTY = originalIsTTY;
  });

  it('routes to renderLive + maybeOpenDashboard when stdout is a TTY (non-json)', async () => {
    process.stdout.isTTY = true;
    const program = new Command();
    program.exitOverride();
    const cap = makeCtx(program);

    simulationTool.register!(cap.ctx);
    await program.parseAsync(['node', 'cli', 'sim', '--open'], { from: 'node' });

    // Interactive path: the static executeSim render is bypassed in favour of
    // the live view, then the dashboard auto-open hook fires.
    expect(cap.renderLiveCalls).toHaveLength(1);
    expect(cap.renderLiveCalls[0]?.[0]).toBe('sim');
    expect(cap.dashboardCalls).toHaveLength(1);
    expect(cap.dashboardCalls[0]).toMatchObject({ openRequested: true, jsonOutput: false });
  });
});
