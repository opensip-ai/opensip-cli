/**
 * CommandOutcome shape — the three outcome flavours construct and serialize.
 *
 * The contract is "one outer schema for every result and error". The load-bearing
 * checks: a run outcome nests the UNCHANGED envelope under `.envelope`; a
 * command-result outcome uses `.data`; a bootstrap/error outcome carries neither
 * payload, only `errors` (+ diagnostics). All three JSON round-trip.
 */

import { HOST_VERDICT_POLICY_FALLBACK } from '@opensip-cli/core';
import { describe, it, expect } from 'vitest';

import { buildSignalEnvelope } from './signal-envelope.js';

import { CLI_DIAGNOSTIC_CODES } from './cli-diagnostic.js';
import type { CommandOutcome } from './command-outcome.js';
import type { CliDiagnostic, RunDiagnostics } from '@opensip-cli/core';

const DIAGNOSTICS: RunDiagnostics = { runId: 'run_1', events: [] };

describe('CommandOutcome', () => {
  it('wraps a run as .envelope without altering the inner envelope', () => {
    const envelope = buildSignalEnvelope({
      tool: 'fit',
      runId: 'run_1',
      createdAt: '2026-06-07T00:00:00.000Z',
      units: [{ slug: 'a', passed: true, durationMs: 1 }],
      signals: [],
      policy: HOST_VERDICT_POLICY_FALLBACK,
      runFaulted: false,
    });
    const outcome: CommandOutcome = {
      kind: 'fit.run',
      status: 'ok',
      exitCode: 0,
      envelope,
      diagnostics: DIAGNOSTICS,
    };
    // The inner envelope is byte-identical — the break is purely the new wrapper.
    expect(outcome.envelope).toBe(envelope);
    expect(outcome.data).toBeUndefined();
    const wire = JSON.stringify(outcome);
    expect((JSON.parse(wire) as CommandOutcome).envelope).toEqual(envelope);
  });

  it('wraps a command result as .data', () => {
    const outcome: CommandOutcome<{ type: string; count: number }> = {
      kind: 'sessions.list',
      status: 'ok',
      exitCode: 0,
      data: { type: 'history', count: 4 },
    };
    expect(outcome.data).toEqual({ type: 'history', count: 4 });
    expect(outcome.envelope).toBeUndefined();
  });

  it('carries a bootstrap error with neither payload, only errors + diagnostics', () => {
    const outcome: CommandOutcome = {
      kind: 'bootstrap.error',
      status: 'error',
      exitCode: 2,
      errors: [
        {
          message: 'No OpenSIP CLI project found.',
          suggestion: 'Run opensip init.',
          code: 'CONFIGURATION_ERROR',
        },
      ],
      diagnostics: DIAGNOSTICS,
    };
    expect(outcome.data).toBeUndefined();
    expect(outcome.envelope).toBeUndefined();
    expect(outcome.errors?.[0]?.suggestion).toBe('Run opensip init.');
    const wire = JSON.stringify(outcome);
    expect(JSON.parse(wire)).toEqual(outcome);
  });

  it('carries a structured commandError substrate on setup failures (ADR-0060)', () => {
    const commandError: CliDiagnostic = {
      severity: 'error',
      code: CLI_DIAGNOSTIC_CODES.OPENSIP_FIT_EMPTY_CHECK_REGISTRY,
      category: 'integrity',
      message: 'Fitness check registry is empty.',
      impact: 'No checks were loaded, so the run cannot produce credible findings.',
      action: 'Verify check packs are installed.',
    };
    const outcome: CommandOutcome = {
      kind: 'fit.run',
      status: 'error',
      exitCode: 2,
      commandError,
      errors: [
        {
          message: commandError.message,
          suggestion: commandError.action,
          code: commandError.code,
          diagnostic: commandError,
        },
      ],
    };
    expect(outcome.commandError).toEqual(commandError);
    const wire = JSON.stringify(outcome);
    expect((JSON.parse(wire) as CommandOutcome).commandError).toEqual(commandError);
  });
});
