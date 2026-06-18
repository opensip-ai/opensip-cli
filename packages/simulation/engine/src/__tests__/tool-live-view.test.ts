/**
 * @fileoverview Tests for simulationTool's live-view wiring (ADR-0016) — the
 * paths the static-render tool.test.ts can't reach:
 *
 *   - the interactive TTY branch of the `sim` handler registers a live view
 *     under the `sim` key, and that callback renders the live view then
 *     delivers the returned envelope to the composition root (cloud +
 *     --report-to egress).
 *   - the interactive TTY action branch routes to cli.renderLive +
 *     maybeOpenReport instead of the static executeSim path.
 *
 * Since release 2.11.0 Phase 3 sim mounts via a `CommandSpec`; the live-view
 * registration moved from the (removed) `register()` mount hook into the
 * handler's interactive branch, where it runs lazily before `cli.renderLive`.
 * We drive the handler directly (the host invokes it post-parse) with
 * `process.stdout.isTTY` forced on. `renderSimLive` is mocked so we exercise
 * the wiring without spinning up a real Ink render host.
 */

import { enterScope, RunScope, applyToolContributeScope } from '@opensip-cli/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { simulationTool } from '../tool.js';

import type { SignalEnvelope } from '@opensip-cli/contracts';
import type { CommandSpec, ToolCliContext } from '@opensip-cli/core';

// Mock the Ink renderer so the live-view callback can run without a real
// terminal. The mock returns a deterministic envelope.
const fakeEnvelope = {
  schemaVersion: 2,
  tool: 'sim',
  verdict: { passed: false, summary: { passed: 0, failed: 1, errors: 0, warnings: 0 } },
} as unknown as SignalEnvelope;

// host-owned-run-timing Phase 2: renderSimLive resolves a ToolRunCompletion
// ({ envelope, session }); the tool reads `.envelope` for egress and the host
// persists `.session`.
vi.mock('../cli/sim-runner.js', () => ({
  renderSimLive: vi.fn(() => Promise.resolve({ envelope: fakeEnvelope })),
}));

const { renderSimLive } = await import('../cli/sim-runner.js');

beforeEach(() => {
  const scope = new RunScope();
  applyToolContributeScope(scope, simulationTool);
  enterScope(scope);
});

afterEach(() => {
  vi.clearAllMocks();
});

/** The single declarative `sim` command sim exports. */
function simHandler(): CommandSpec<Record<string, unknown>, ToolCliContext>['handler'] {
  const spec = simulationTool.commandSpecs?.[0];
  if (spec === undefined) throw new Error('simulationTool exposes no commandSpecs');
  return (spec as CommandSpec<Record<string, unknown>, ToolCliContext>).handler;
}

interface Captured {
  ctx: ToolCliContext;
  liveViews: Map<string, (args: unknown) => Promise<void>>;
  delivered: { envelope: SignalEnvelope; opts: unknown }[];
  renderLiveCalls: [string, unknown][];
  dashboardCalls: unknown[];
  exitCodes: number[];
}

function makeCtx(): Captured {
  const liveViews = new Map<string, (args: unknown) => Promise<void>>();
  const delivered: Captured['delivered'] = [];
  const renderLiveCalls: Captured['renderLiveCalls'] = [];
  const dashboardCalls: unknown[] = [];
  const exitCodes: number[] = [];
  const ctx = {
    scope: new RunScope(),
    render: vi.fn(() => Promise.resolve()),
    registerLiveView: vi.fn((key: string, cb: (args: unknown) => Promise<void>) => {
      liveViews.set(key, cb);
    }),
    renderLive: vi.fn((key: string, args: unknown) => {
      renderLiveCalls.push([key, args]);
      return Promise.resolve();
    }),
    maybeOpenReport: vi.fn((arg: unknown) => {
      dashboardCalls.push(arg);
      return Promise.resolve();
    }),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    setExitCode: (code: number) => exitCodes.push(code),
    emitJson: vi.fn(),
    emitRaw: vi.fn(),
    emitEnvelope: vi.fn(),
    emitError: vi.fn(),
    deliverSignals: vi.fn((envelope: SignalEnvelope, opts: unknown) => {
      delivered.push({ envelope, opts });
      return Promise.resolve();
    }),
    writeSarif: vi.fn(() => Promise.resolve()),
  } as unknown as ToolCliContext;
  return { ctx, liveViews, delivered, renderLiveCalls, dashboardCalls, exitCodes };
}

describe('simulationTool live-view callback (ADR-0016)', () => {
  const originalIsTTY = process.stdout.isTTY;
  afterEach(() => {
    process.stdout.isTTY = originalIsTTY;
  });

  it('registers a live view under the `sim` key and delivers the rendered envelope', async () => {
    process.stdout.isTTY = true;
    const cap = makeCtx();

    // The interactive branch registers the live view, so run the handler once
    // to install it, then exercise the registered callback directly.
    await simHandler()({ cwd: '/proj' }, cap.ctx);

    const callback = cap.liveViews.get('sim');
    expect(callback).toBeDefined();

    // Invoke the live-view callback the dispatcher would call.
    await callback?.({ cwd: '/proj', reportTo: 'https://cloud.example', apiKey: 'k' });

    // The Ink renderer ran with setExitCode wired through (once per run via the
    // handler's renderLive, once here via the direct callback invocation).
    expect(renderSimLive).toHaveBeenCalled();
    // The returned envelope was delivered to the composition root with egress
    // options derived from the args. ADR-0035: a normal run does NOT pass
    // `runFailed` — the host derives the findings exit from envelope.verdict.passed.
    expect(cap.delivered.length).toBeGreaterThanOrEqual(1);
    const last = cap.delivered.at(-1);
    expect(last?.envelope).toBe(fakeEnvelope);
    expect(last?.opts).toMatchObject({
      cwd: '/proj',
      reportTo: 'https://cloud.example',
      apiKey: 'k',
    });
    expect(last?.opts).not.toHaveProperty('runFailed');
  });

  it('does not deliver when the renderer returns no envelope', async () => {
    process.stdout.isTTY = true;
    // The handler's own renderLive (the live view) is dispatched through
    // cli.renderLive (mocked to a no-op), so it does not invoke renderSimLive;
    // only the directly-invoked callback below does, returning a completion with
    // no envelope (host-owned-run-timing Phase 2).
    (
      renderSimLive as unknown as { mockResolvedValueOnce: (v: unknown) => void }
    ).mockResolvedValueOnce({ envelope: undefined });
    const cap = makeCtx();
    await simHandler()({ cwd: '/proj' }, cap.ctx);

    await cap.liveViews.get('sim')?.({ cwd: '/proj' });

    expect(cap.delivered).toHaveLength(0);
  });
});

describe('simulationTool action — interactive TTY branch', () => {
  const originalIsTTY = process.stdout.isTTY;

  afterEach(() => {
    process.stdout.isTTY = originalIsTTY;
  });

  it('routes to renderLive + maybeOpenReport when stdout is a TTY (non-json)', async () => {
    process.stdout.isTTY = true;
    const cap = makeCtx();

    await simHandler()({ open: true }, cap.ctx);

    // Interactive path: the static executeSim render is bypassed in favour of
    // the live view, then the report auto-open hook fires.
    expect(cap.renderLiveCalls).toHaveLength(1);
    expect(cap.renderLiveCalls[0]?.[0]).toBe('sim');
    expect(cap.dashboardCalls).toHaveLength(1);
    expect(cap.dashboardCalls[0]).toMatchObject({ openRequested: true, jsonOutput: false });
  });
});
