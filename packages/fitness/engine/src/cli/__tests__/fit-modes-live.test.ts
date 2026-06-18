/**
 * runLiveMode / runJsonMode dispatch (ADR-0011 Phase 6).
 *
 * The animated Ink live view is a TTY-only affordance. On a TTY `runLiveMode`
 * renders live (and the tool's `registerLiveView` callback delivers signals);
 * in a pipe / CI / redirect (non-TTY) it falls back to running the engine,
 * rendering the static RunPresentation through the seam, then delivering the
 * envelope once at the composition root. `runJsonMode` emits the envelope via
 * `cli.emitEnvelope` and delivers once. These tests pin the dispatch + the
 * single `deliverSignals` egress call (the root owns exit 4, tested there).
 */

import { buildSignalEnvelope } from '@opensip-cli/contracts';
import {
  createRunTimer,
  HOST_VERDICT_POLICY_FALLBACK,
  type ToolCliContext,
} from '@opensip-cli/core';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { runJsonMode, runLiveMode } from '../fit-modes.js';
import { executeFit } from '../fit.js';

import type { SignalEnvelope } from '@opensip-cli/contracts';

vi.mock('../fit.js', () => ({ executeFit: vi.fn() }));

const executeFitMock = executeFit as unknown as MockInstance;

interface MockCliBag {
  readonly cli: ToolCliContext;
  readonly renderLive: MockInstance;
  readonly render: MockInstance;
  readonly setExitCode: MockInstance;
  readonly maybeOpenReport: MockInstance;
  readonly emitEnvelope: MockInstance;
  readonly emitError: MockInstance;
  readonly deliverSignals: MockInstance;
}

function mockCli(): MockCliBag {
  const renderLive = vi.fn().mockResolvedValue(undefined);
  const render = vi.fn().mockResolvedValue(undefined);
  const setExitCode = vi.fn();
  const maybeOpenReport = vi.fn().mockResolvedValue(undefined);
  const emitJson = vi.fn();
  const emitEnvelope = vi.fn();
  // 2.12.0: the structured-error seam. Mirror the host — it sets the exit code.
  const emitError = vi.fn((detail: { exitCode: number }) => setExitCode(detail.exitCode));
  const deliverSignals = vi.fn().mockResolvedValue(undefined);
  const cli = {
    renderLive,
    render,
    setExitCode,
    maybeOpenReport,
    emitJson,
    emitEnvelope,
    emitError,
    deliverSignals,
    logger: console,
    scope: { datastore: () => undefined },
    runSession: {
      timing: createRunTimer(),
      record: () => undefined,
    },
  } as unknown as ToolCliContext;
  return {
    cli,
    renderLive,
    render,
    setExitCode,
    maybeOpenReport,
    emitEnvelope,
    emitError,
    deliverSignals,
  };
}

const args = { cwd: '/x' } as unknown as Parameters<typeof runLiveMode>[0];

function envelope(): SignalEnvelope {
  return buildSignalEnvelope({
    tool: 'fit',
    runId: 'r',
    createdAt: '2026-06-04T00:00:00.000Z',
    units: [],
    signals: [],
    policy: HOST_VERDICT_POLICY_FALLBACK,
    runFaulted: false,
  });
}

const savedTTY = process.stdout.isTTY;
function setTTY(value: boolean): void {
  Object.defineProperty(process.stdout, 'isTTY', { value, configurable: true });
}

beforeEach(() => {
  executeFitMock.mockReset();
});

afterEach(() => {
  Object.defineProperty(process.stdout, 'isTTY', { value: savedTTY, configurable: true });
  vi.restoreAllMocks();
});

describe('runLiveMode', () => {
  it('renders the animated live view on a TTY (and never the static seam)', async () => {
    setTTY(true);
    const { cli, renderLive, render, maybeOpenReport, deliverSignals } = mockCli();
    await runLiveMode(args, cli, 'fit', false);
    expect(renderLive).toHaveBeenCalledWith('fit', args);
    expect(render).not.toHaveBeenCalled();
    expect(executeFitMock).not.toHaveBeenCalled();
    // The TTY live view delivers via the tool's registerLiveView callback,
    // not runLiveMode — so runLiveMode itself does not call deliverSignals here.
    expect(deliverSignals).not.toHaveBeenCalled();
    expect(maybeOpenReport).toHaveBeenCalledTimes(1);
  });

  it('falls back to the static RunPresentation result + delivers once on non-TTY', async () => {
    setTTY(false);
    const result = { type: 'run-presentation', tool: 'fitness' };
    executeFitMock.mockResolvedValue({ result, envelope: envelope() });
    const { cli, renderLive, render, setExitCode, deliverSignals } = mockCli();
    await runLiveMode(args, cli, 'fit', false);
    expect(renderLive).not.toHaveBeenCalled();
    expect(executeFitMock).toHaveBeenCalledTimes(1);
    expect(render).toHaveBeenCalledWith(result);
    expect(deliverSignals).toHaveBeenCalledTimes(1);
    // ADR-0035: the mode no longer sets the findings exit — the host derives it
    // from envelope.verdict.passed inside deliverSignals (mocked here; the exit
    // behaviour is covered in envelope-routing.test.ts).
    expect(setExitCode).not.toHaveBeenCalled();
  });

  it('delivers the envelope on a non-TTY run; the host owns the findings exit (ADR-0035)', async () => {
    setTTY(false);
    executeFitMock.mockResolvedValue({
      result: { type: 'run-presentation', tool: 'fitness' },
      envelope: envelope(),
    });
    const { cli, render, deliverSignals } = mockCli();
    await runLiveMode(args, cli, 'fit', false);
    // The mode renders + delivers; deliverSignals (the host seam) owns the exit.
    expect(render).toHaveBeenCalled();
    expect(deliverSignals).toHaveBeenCalledTimes(1);
    expect(deliverSignals.mock.calls[0]?.[1]).not.toHaveProperty('runFailed');
  });

  it("propagates an error result's exit code on a non-TTY run (no delivery)", async () => {
    setTTY(false);
    const result = { type: 'error', exitCode: 2, message: 'no config' };
    executeFitMock.mockResolvedValue({ result });
    const { cli, setExitCode, render, deliverSignals } = mockCli();
    await runLiveMode(args, cli, 'fit', false);
    expect(setExitCode).toHaveBeenCalledWith(2);
    // envelope-first-presentation (plan Assumption 5): an error-before-envelope
    // run renders the `error` variant verbatim — NEVER a `run-presentation`. The
    // host routes it through `errorView`, not `presentationToView` (proved in
    // packages/cli/.../envelope-first-invariants.test.tsx).
    expect(render).toHaveBeenCalledWith(result);
    expect(render).toHaveBeenCalledTimes(1);
    expect(render.mock.calls[0]?.[0]).toMatchObject({ type: 'error' });
    expect(render.mock.calls[0]?.[0]).not.toMatchObject({ type: 'run-presentation' });
    expect(deliverSignals).not.toHaveBeenCalled();
  });
});

describe('runJsonMode', () => {
  const reportArgs = {
    cwd: '/x',
    reportTo: 'https://sink.example',
    apiKey: 'k',
  } as unknown as Parameters<typeof runJsonMode>[0];

  it('emits the envelope and delivers signals once (no runFailed — host derives exit)', async () => {
    const env = envelope();
    executeFitMock.mockResolvedValue({
      result: { type: 'run-presentation', tool: 'fitness' },
      envelope: env,
    });
    const { cli, emitEnvelope, deliverSignals } = mockCli();
    await runJsonMode(reportArgs, cli);
    expect(emitEnvelope).toHaveBeenCalledWith(env);
    expect(deliverSignals).toHaveBeenCalledTimes(1);
    // ADR-0035: a normal run delivers WITHOUT `runFailed`; the host derives the
    // findings exit from envelope.verdict.passed.
    expect(deliverSignals).toHaveBeenCalledWith(env, {
      cwd: '/x',
      reportTo: 'https://sink.example',
      apiKey: 'k',
    });
  });

  it('delivers without runFailed on a failing run; the host owns the exit (ADR-0035)', async () => {
    const env = envelope();
    executeFitMock.mockResolvedValue({
      result: { type: 'run-presentation', tool: 'fitness' },
      envelope: env,
    });
    const { cli, setExitCode, deliverSignals } = mockCli();
    await runJsonMode(reportArgs, cli);
    // The mode no longer computes shouldFail or sets the exit — deliverSignals
    // (the host seam) owns it, derived from the envelope verdict.
    expect(setExitCode).not.toHaveBeenCalled();
    expect(deliverSignals.mock.calls[0]?.[1]).not.toHaveProperty('runFailed');
  });

  it('emits an error payload and does not deliver on an error result', async () => {
    executeFitMock.mockResolvedValue({
      result: { type: 'error', exitCode: 2, message: 'no config' },
    });
    const { cli, emitEnvelope, emitError, deliverSignals, setExitCode } = mockCli();
    await runJsonMode(args, cli);
    // 2.12.0 (§5.5): a failed --json run emits a structured error through the
    // `emitError` seam (host wraps it + sets the exit code), not a bare envelope.
    expect(emitError).toHaveBeenCalledWith({ message: 'no config', exitCode: 2 });
    expect(setExitCode).toHaveBeenCalledWith(2);
    expect(emitEnvelope).not.toHaveBeenCalled();
    expect(deliverSignals).not.toHaveBeenCalled();
  });
});
