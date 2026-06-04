/**
 * runLiveMode / runJsonMode dispatch (ADR-0011 Phase 6).
 *
 * The animated Ink live view is a TTY-only affordance. On a TTY `runLiveMode`
 * renders live (and the tool's `registerLiveView` callback delivers signals);
 * in a pipe / CI / redirect (non-TTY) it falls back to running the engine,
 * rendering the static `fit-done` result through the seam, then delivering the
 * envelope once at the composition root. `runJsonMode` emits the envelope via
 * `cli.emitEnvelope` and delivers once. These tests pin the dispatch + the
 * single `deliverSignals` egress call (the root owns exit 4, tested there).
 */

import { EXIT_CODES, buildSignalEnvelope } from '@opensip-tools/contracts';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { runJsonMode, runLiveMode } from '../fit-modes.js';
import { executeFit } from '../fit.js';

import type { SignalEnvelope } from '@opensip-tools/contracts';
import type { ToolCliContext } from '@opensip-tools/core';

vi.mock('../fit.js', () => ({ executeFit: vi.fn() }));

const executeFitMock = executeFit as unknown as MockInstance;

interface MockCliBag {
  readonly cli: ToolCliContext;
  readonly renderLive: MockInstance;
  readonly render: MockInstance;
  readonly setExitCode: MockInstance;
  readonly maybeOpenDashboard: MockInstance;
  readonly emitEnvelope: MockInstance;
  readonly deliverSignals: MockInstance;
}

function mockCli(): MockCliBag {
  const renderLive = vi.fn().mockResolvedValue(undefined);
  const render = vi.fn().mockResolvedValue(undefined);
  const setExitCode = vi.fn();
  const maybeOpenDashboard = vi.fn().mockResolvedValue(undefined);
  const emitJson = vi.fn();
  const emitEnvelope = vi.fn();
  const deliverSignals = vi.fn().mockResolvedValue(undefined);
  const cli = {
    renderLive,
    render,
    setExitCode,
    maybeOpenDashboard,
    emitJson,
    emitEnvelope,
    deliverSignals,
    logger: console,
    scope: { datastore: () => undefined },
  } as unknown as ToolCliContext;
  return { cli, renderLive, render, setExitCode, maybeOpenDashboard, emitEnvelope, deliverSignals };
}

const args = { cwd: '/x' } as unknown as Parameters<typeof runLiveMode>[0];

function envelope(): SignalEnvelope {
  return buildSignalEnvelope({
    tool: 'fit',
    runId: 'r',
    createdAt: '2026-06-04T00:00:00.000Z',
    units: [],
    signals: [],
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
    const { cli, renderLive, render, maybeOpenDashboard, deliverSignals } = mockCli();
    await runLiveMode(args, cli, 'fit', false);
    expect(renderLive).toHaveBeenCalledWith('fit', args);
    expect(render).not.toHaveBeenCalled();
    expect(executeFitMock).not.toHaveBeenCalled();
    // The TTY live view delivers via the tool's registerLiveView callback,
    // not runLiveMode — so runLiveMode itself does not call deliverSignals here.
    expect(deliverSignals).not.toHaveBeenCalled();
    expect(maybeOpenDashboard).toHaveBeenCalledTimes(1);
  });

  it('falls back to the static fit-done result + delivers once on non-TTY', async () => {
    setTTY(false);
    const result = { type: 'fit-done', shouldFail: false };
    executeFitMock.mockResolvedValue({ result, envelope: envelope() });
    const { cli, renderLive, render, setExitCode, deliverSignals } = mockCli();
    await runLiveMode(args, cli, 'fit', false);
    expect(renderLive).not.toHaveBeenCalled();
    expect(executeFitMock).toHaveBeenCalledTimes(1);
    expect(render).toHaveBeenCalledWith(result);
    expect(deliverSignals).toHaveBeenCalledTimes(1);
    // A passing run that didn't breach the fail threshold leaves the exit code alone.
    expect(setExitCode).not.toHaveBeenCalled();
  });

  it('exits RUNTIME_ERROR on a non-TTY run that breached the fail threshold', async () => {
    setTTY(false);
    executeFitMock.mockResolvedValue({ result: { type: 'fit-done', shouldFail: true }, envelope: envelope() });
    const { cli, setExitCode, render } = mockCli();
    await runLiveMode(args, cli, 'fit', false);
    expect(setExitCode).toHaveBeenCalledWith(EXIT_CODES.RUNTIME_ERROR);
    expect(render).toHaveBeenCalled();
  });

  it('propagates an error result\'s exit code on a non-TTY run (no delivery)', async () => {
    setTTY(false);
    const result = { type: 'error', exitCode: 2, message: 'no config' };
    executeFitMock.mockResolvedValue({ result });
    const { cli, setExitCode, render, deliverSignals } = mockCli();
    await runLiveMode(args, cli, 'fit', false);
    expect(setExitCode).toHaveBeenCalledWith(2);
    expect(render).toHaveBeenCalledWith(result);
    expect(deliverSignals).not.toHaveBeenCalled();
  });
});

describe('runJsonMode', () => {
  const reportArgs = {
    cwd: '/x',
    reportTo: 'https://sink.example',
    apiKey: 'k',
  } as unknown as Parameters<typeof runJsonMode>[0];

  it('emits the envelope and delivers signals once', async () => {
    const env = envelope();
    executeFitMock.mockResolvedValue({ result: { type: 'fit-done', shouldFail: false }, envelope: env });
    const { cli, emitEnvelope, deliverSignals } = mockCli();
    await runJsonMode(reportArgs, cli);
    expect(emitEnvelope).toHaveBeenCalledWith(env);
    expect(deliverSignals).toHaveBeenCalledTimes(1);
    expect(deliverSignals).toHaveBeenCalledWith(env, {
      cwd: '/x',
      reportTo: 'https://sink.example',
      apiKey: 'k',
      runFailed: false,
    });
  });

  it('passes runFailed=true to deliverSignals on a failing run (root owns exit 4)', async () => {
    const env = envelope();
    executeFitMock.mockResolvedValue({ result: { type: 'fit-done', shouldFail: true }, envelope: env });
    const { cli, setExitCode, deliverSignals } = mockCli();
    await runJsonMode(reportArgs, cli);
    expect(setExitCode).toHaveBeenCalledWith(EXIT_CODES.RUNTIME_ERROR);
    expect(deliverSignals).toHaveBeenCalledWith(env, expect.objectContaining({ runFailed: true }));
  });

  it('emits an error payload and does not deliver on an error result', async () => {
    executeFitMock.mockResolvedValue({ result: { type: 'error', exitCode: 2, message: 'no config' } });
    const { cli, emitEnvelope, deliverSignals, setExitCode } = mockCli();
    await runJsonMode(args, cli);
    expect(setExitCode).toHaveBeenCalledWith(2);
    expect(emitEnvelope).not.toHaveBeenCalled();
    expect(deliverSignals).not.toHaveBeenCalled();
  });
});
