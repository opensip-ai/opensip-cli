/**
 * assemble-outcome — the host stamper. Pins kind/status/exitCode derivation for
 * each outcome flavour (envelope / result / error) and the byte-identity of the
 * wrapped envelope.
 */

import { buildSignalEnvelope, type ErrorResult } from '@opensip-cli/contracts';
import {
  ConfigurationError,
  HOST_VERDICT_POLICY_FALLBACK,
  NotFoundError,
} from '@opensip-cli/core';
import { describe, it, expect } from 'vitest';

import {
  kindFromEnvelope,
  kindFromResult,
  outcomeFromEnvelope,
  outcomeFromError,
  outcomeFromErrorMessage,
  outcomeFromResult,
} from '../commands/assemble-outcome.js';

const ENVELOPE = buildSignalEnvelope({
  tool: 'graph',
  runId: 'run_1',
  createdAt: '2026-06-07T00:00:00.000Z',
  units: [{ slug: 'a', passed: true, durationMs: 1 }],
  signals: [],
  policy: HOST_VERDICT_POLICY_FALLBACK,
  runFaulted: false,
});

describe('kind derivation', () => {
  it('derives a run kind from the envelope tool id', () => {
    expect(kindFromEnvelope(ENVELOPE)).toBe('graph.run');
  });
  it('derives a result kind from the CommandResult discriminant, else a neutral fallback', () => {
    expect(kindFromResult({ type: 'history' })).toBe('history');
    expect(kindFromResult({ count: 3 })).toBe('command.result');
    expect(kindFromResult(null)).toBe('command.result');
  });
});

describe('outcomeFromEnvelope', () => {
  it('wraps the UNCHANGED envelope under .envelope as a status:ok outcome', () => {
    const outcome = outcomeFromEnvelope(ENVELOPE, 1);
    expect(outcome).toEqual({ kind: 'graph.run', status: 'ok', exitCode: 1, envelope: ENVELOPE });
    expect(outcome.envelope).toBe(ENVELOPE); // identity preserved — the break is purely the wrapper
  });
});

describe('outcomeFromResult', () => {
  it('puts a normal CommandResult under .data', () => {
    const result = { type: 'list-checks', totalCount: 2 };
    const outcome = outcomeFromResult(result, 0);
    expect(outcome.status).toBe('ok');
    expect(outcome.kind).toBe('list-checks');
    expect(outcome.data).toBe(result);
    expect(outcome.envelope).toBeUndefined();
  });

  it('maps an ErrorResult to a status:error outcome carrying its own exit code + structured error', () => {
    const result: ErrorResult = {
      type: 'error',
      message: 'boom',
      suggestion: 'try X',
      exitCode: 2,
    };
    const outcome = outcomeFromResult(result, 0);
    expect(outcome.status).toBe('error');
    expect(outcome.exitCode).toBe(2);
    expect(outcome.errors).toEqual([{ message: 'boom', suggestion: 'try X' }]);
  });
});

describe('outcomeFromError', () => {
  it('maps a typed ToolError to its canonical exit code + code', () => {
    const outcome = outcomeFromError(new NotFoundError('Check not found: x'), {
      kind: 'bootstrap.error',
    });
    expect(outcome.kind).toBe('bootstrap.error');
    expect(outcome.status).toBe('error');
    expect(outcome.exitCode).toBe(3); // CHECK_NOT_FOUND
    expect(outcome.errors?.[0]?.message).toContain('not found');
    expect(outcome.errors?.[0]?.code).toBeDefined();
  });

  it('maps a ConfigurationError to exit 2 and surfaces a suggestion', () => {
    const outcome = outcomeFromError(new ConfigurationError('Recipe not found: nope'));
    expect(outcome.exitCode).toBe(2);
    expect(outcome.errors?.[0]?.suggestion).toBeDefined();
  });

  it('maps an untyped error to RUNTIME_ERROR (exit 1)', () => {
    const outcome = outcomeFromError(new Error('kaboom'));
    expect(outcome.exitCode).toBe(1);
    expect(outcome.errors?.[0]?.message).toBe('kaboom');
  });
});

describe('outcomeFromErrorMessage', () => {
  it('builds a status:error outcome from a resolved message + exit code', () => {
    const outcome = outcomeFromErrorMessage({
      message: 'no config',
      exitCode: 2,
      suggestion: 'init',
    });
    expect(outcome).toEqual({
      kind: 'command.error',
      status: 'error',
      exitCode: 2,
      errors: [{ message: 'no config', suggestion: 'init' }],
    });
  });
});
