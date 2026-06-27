import { EXIT_CODES } from '@opensip-cli/contracts';
import { ConfigurationError, NotFoundError, SystemError, ValidationError } from '@opensip-cli/core';
import { describe, expect, it, vi } from 'vitest';

import { createReportFailure, resolveReportFailure } from '../report-failure.js';

describe('resolveReportFailure', () => {
  it('maps each ToolError subclass to the canonical exit code', () => {
    expect(resolveReportFailure({ error: new NotFoundError('missing') }).exitCode).toBe(
      EXIT_CODES.CHECK_NOT_FOUND,
    );
    expect(resolveReportFailure({ error: new ConfigurationError('bad') }).exitCode).toBe(
      EXIT_CODES.CONFIGURATION_ERROR,
    );
    expect(resolveReportFailure({ error: new ValidationError('bad') }).exitCode).toBe(
      EXIT_CODES.CONFIGURATION_ERROR,
    );
  });

  it('maps untyped Error to runtime error', () => {
    const resolved = resolveReportFailure({ error: new Error('boom') });
    expect(resolved.exitCode).toBe(EXIT_CODES.RUNTIME_ERROR);
    expect(resolved.message).toBe('boom');
  });

  it('normalizes bare non-Error throwables to runtime error failures', () => {
    expect(resolveReportFailure({ error: 'string boom' })).toMatchObject({
      exitCode: EXIT_CODES.RUNTIME_ERROR,
      message: 'string boom',
    });
    expect(resolveReportFailure({ error: 42 })).toMatchObject({
      exitCode: EXIT_CODES.RUNTIME_ERROR,
      message: '42',
    });
    expect(resolveReportFailure({ error: { reason: 'plain' } })).toMatchObject({
      exitCode: EXIT_CODES.RUNTIME_ERROR,
      message: '[object Object]',
    });
  });

  it('truncates derived throwable messages before surfacing them', () => {
    const resolved = resolveReportFailure({ error: new Error('x'.repeat(2000)) });
    expect(resolved.exitCode).toBe(EXIT_CODES.RUNTIME_ERROR);
    expect(resolved.message).toHaveLength(1000);
    expect(resolved.message.endsWith('...')).toBe(true);
  });

  it('preserves ToolError code and canonical mapped exit code', () => {
    const resolved = resolveReportFailure({ error: new NotFoundError('missing') });
    expect(resolved).toMatchObject({
      exitCode: EXIT_CODES.CHECK_NOT_FOUND,
      message: 'missing',
      code: 'NOT_FOUND',
    });
  });

  it('throws SystemError when message and exitCode are missing', () => {
    expect(() => resolveReportFailure({})).toThrow(SystemError);
  });

  it('honors explicit overrides over derived values', () => {
    const resolved = resolveReportFailure({
      error: new NotFoundError('x'),
      message: 'custom',
      exitCode: 9,
      code: 'CUSTOM',
    });
    expect(resolved).toMatchObject({ message: 'custom', exitCode: 9, code: 'CUSTOM' });
  });
});

function makeReportFailureDeps() {
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return {
    log,
    setExitCode: vi.fn(),
    render: vi.fn(() => Promise.resolve()),
    emitError: vi.fn(),
    writeStderr: vi.fn(() => true),
    diagnostics: { event: vi.fn() },
    getLogger: () => log,
    getDiagnostics: () => ({ event: vi.fn() }) as never,
  };
}

describe('createReportFailure', () => {
  it('human path renders an error result', async () => {
    const deps = makeReportFailureDeps();
    const report = createReportFailure({
      getLogger: deps.getLogger,
      setExitCode: deps.setExitCode,
      render: deps.render,
      emitError: deps.emitError,
      writeStderr: deps.writeStderr,
      getDiagnostics: deps.getDiagnostics,
    });
    await report({ message: 'nope', exitCode: 2 });
    expect(deps.render).toHaveBeenCalledWith({ type: 'error', message: 'nope', exitCode: 2 });
    expect(deps.setExitCode).toHaveBeenCalledWith(2);
  });

  it('json path emits structured error', async () => {
    const deps = makeReportFailureDeps();
    const report = createReportFailure({
      getLogger: deps.getLogger,
      setExitCode: deps.setExitCode,
      render: deps.render,
      emitError: deps.emitError,
      writeStderr: deps.writeStderr,
    });
    await report({ message: 'nope', exitCode: 3, jsonRequested: true, code: 'not-found' });
    expect(deps.emitError).toHaveBeenCalledWith({
      message: 'nope',
      exitCode: 3,
      code: 'not-found',
    });
    expect(deps.render).not.toHaveBeenCalled();
  });

  it('diagnostic path writes formatted stderr', async () => {
    const deps = makeReportFailureDeps();
    const report = createReportFailure({
      getLogger: deps.getLogger,
      setExitCode: deps.setExitCode,
      render: deps.render,
      emitError: deps.emitError,
      writeStderr: deps.writeStderr,
    });
    await report({
      message: 'ignored for diagnostic branch',
      exitCode: 2,
      diagnostic: {
        severity: 'error',
        code: 'CONFIG.BAD',
        category: 'configuration',
        impact: 'cannot run',
      },
    });
    expect(deps.writeStderr).toHaveBeenCalled();
    expect(deps.render).not.toHaveBeenCalled();
  });

  it('logs default tool.command.failed when log detail omitted', async () => {
    const deps = makeReportFailureDeps();
    const report = createReportFailure({
      getLogger: deps.getLogger,
      setExitCode: deps.setExitCode,
      render: deps.render,
      emitError: deps.emitError,
      writeStderr: deps.writeStderr,
    });
    await report({ message: 'failed', exitCode: 1 });
    expect(deps.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ evt: 'tool.command.failed', message: 'failed', exitCode: 1 }),
    );
  });
});
