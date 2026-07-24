import { buildSignalEnvelope, EXIT_CODES } from '@opensip-cli/contracts';
import { describe, expect, it, vi } from 'vitest';

import { applyAdvisoryExitCode } from '../lib/apply-advisory-exit.js';

import type { SignalEnvelope } from '@opensip-cli/contracts';
import type { ToolCliContext } from '@opensip-cli/core';

function cliWithExit(code?: number): ToolCliContext & { _state: { code?: number } } {
  const state = { code };
  return {
    getExitCode: () => state.code,
    setExitCode: (next: number) => {
      state.code = next;
    },
    _state: state,
    reportFailure: vi.fn(() => Promise.resolve()),
  } as unknown as ToolCliContext & { _state: { code?: number } };
}

function envelope(runFaulted: boolean): SignalEnvelope {
  return buildSignalEnvelope({
    tool: 'yagni',
    runId: 'run-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    units: [],
    signals: [],
    policy: { failOnErrors: 0, failOnWarnings: 0 },
    runFaulted,
  });
}

describe('applyAdvisoryExitCode', () => {
  it('forces success when advisory policy is active', () => {
    const cli = cliWithExit(EXIT_CODES.CONFIGURATION_ERROR);
    applyAdvisoryExitCode(cli, { failOnErrors: 0, failOnWarnings: 0 }, envelope(false));
    expect(cli._state.code).toBe(EXIT_CODES.SUCCESS);
  });

  it('preserves the failure exit when the run faulted (crashed detector)', () => {
    const cli = cliWithExit(EXIT_CODES.RUNTIME_ERROR);
    applyAdvisoryExitCode(cli, { failOnErrors: 0, failOnWarnings: 0 }, envelope(true));
    expect(cli._state.code).toBe(EXIT_CODES.RUNTIME_ERROR);
  });

  it('preserves report-upload failure exit 4', () => {
    const cli = cliWithExit(EXIT_CODES.REPORT_FAILED);
    applyAdvisoryExitCode(cli, { failOnErrors: 0, failOnWarnings: 0 }, envelope(false));
    expect(cli._state.code).toBe(EXIT_CODES.REPORT_FAILED);
  });

  it('does not override when gate policy is enabled', () => {
    const cli = cliWithExit(EXIT_CODES.RUNTIME_ERROR);
    applyAdvisoryExitCode(cli, { failOnErrors: 1, failOnWarnings: 0 }, envelope(false));
    expect(cli._state.code).toBe(EXIT_CODES.RUNTIME_ERROR);
  });
});
