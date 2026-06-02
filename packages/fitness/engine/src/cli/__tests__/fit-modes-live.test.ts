/**
 * runLiveMode dispatch — the animated Ink live view is a TTY-only affordance.
 * On a TTY it renders live; in a pipe / CI / redirect (non-TTY) it falls back
 * to running the engine and emitting the static `fit-done` result through the
 * render seam (dual-rendered as plain text), mirroring the live runner's
 * single-exit-code policy. These tests pin both branches.
 */

import { EXIT_CODES } from '@opensip-tools/contracts';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { runLiveMode } from '../fit-modes.js';
import { executeFit } from '../fit.js';

import type { ToolCliContext } from '@opensip-tools/core';

vi.mock('../fit.js', () => ({ executeFit: vi.fn() }));

const executeFitMock = executeFit as unknown as MockInstance;

interface MockCliBag {
  readonly cli: ToolCliContext;
  readonly renderLive: MockInstance;
  readonly render: MockInstance;
  readonly setExitCode: MockInstance;
  readonly maybeOpenDashboard: MockInstance;
}

function mockCli(): MockCliBag {
  const renderLive = vi.fn().mockResolvedValue(undefined);
  const render = vi.fn().mockResolvedValue(undefined);
  const setExitCode = vi.fn();
  const maybeOpenDashboard = vi.fn().mockResolvedValue(undefined);
  const cli = {
    renderLive,
    render,
    setExitCode,
    maybeOpenDashboard,
    logger: console,
    scope: { datastore: () => undefined },
  } as unknown as ToolCliContext;
  return { cli, renderLive, render, setExitCode, maybeOpenDashboard };
}

const args = { cwd: '/x' } as unknown as Parameters<typeof runLiveMode>[0];

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
    const { cli, renderLive, render, maybeOpenDashboard } = mockCli();
    await runLiveMode(args, cli, 'fit', false);
    expect(renderLive).toHaveBeenCalledWith('fit', args);
    expect(render).not.toHaveBeenCalled();
    expect(executeFitMock).not.toHaveBeenCalled();
    expect(maybeOpenDashboard).toHaveBeenCalledTimes(1);
  });

  it('falls back to the static fit-done result through the seam when stdout is not a TTY', async () => {
    setTTY(false);
    const result = { type: 'fit-done', shouldFail: false };
    executeFitMock.mockResolvedValue({ result, output: {} });
    const { cli, renderLive, render, setExitCode } = mockCli();
    await runLiveMode(args, cli, 'fit', false);
    expect(renderLive).not.toHaveBeenCalled();
    expect(executeFitMock).toHaveBeenCalledTimes(1);
    expect(render).toHaveBeenCalledWith(result);
    // A passing run that didn't breach the fail threshold leaves the exit code alone.
    expect(setExitCode).not.toHaveBeenCalled();
  });

  it('exits RUNTIME_ERROR on a non-TTY run that breached the fail threshold', async () => {
    setTTY(false);
    executeFitMock.mockResolvedValue({ result: { type: 'fit-done', shouldFail: true }, output: {} });
    const { cli, setExitCode, render } = mockCli();
    await runLiveMode(args, cli, 'fit', false);
    expect(setExitCode).toHaveBeenCalledWith(EXIT_CODES.RUNTIME_ERROR);
    expect(render).toHaveBeenCalled();
  });

  it('propagates an error result\'s exit code on a non-TTY run', async () => {
    setTTY(false);
    const result = { type: 'error', exitCode: 2, message: 'no config' };
    executeFitMock.mockResolvedValue({ result });
    const { cli, setExitCode, render } = mockCli();
    await runLiveMode(args, cli, 'fit', false);
    expect(setExitCode).toHaveBeenCalledWith(2);
    expect(render).toHaveBeenCalledWith(result);
  });
});
