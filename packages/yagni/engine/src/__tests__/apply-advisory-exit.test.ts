import { EXIT_CODES } from '@opensip-cli/contracts';
import { describe, expect, it, vi } from 'vitest';

import { applyAdvisoryExitCode } from '../lib/apply-advisory-exit.js';

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

describe('applyAdvisoryExitCode', () => {
  it('forces success when advisory policy is active', () => {
    const cli = cliWithExit(EXIT_CODES.CONFIGURATION_ERROR);
    applyAdvisoryExitCode(cli, { failOnErrors: 0, failOnWarnings: 0 });
    expect(cli._state.code).toBe(EXIT_CODES.SUCCESS);
  });

  it('preserves report-upload failure exit 4', () => {
    const cli = cliWithExit(EXIT_CODES.REPORT_FAILED);
    applyAdvisoryExitCode(cli, { failOnErrors: 0, failOnWarnings: 0 });
    expect(cli._state.code).toBe(EXIT_CODES.REPORT_FAILED);
  });

  it('does not override when gate policy is enabled', () => {
    const cli = cliWithExit(EXIT_CODES.RUNTIME_ERROR);
    applyAdvisoryExitCode(cli, { failOnErrors: 1, failOnWarnings: 0 });
    expect(cli._state.code).toBe(EXIT_CODES.RUNTIME_ERROR);
  });
});
