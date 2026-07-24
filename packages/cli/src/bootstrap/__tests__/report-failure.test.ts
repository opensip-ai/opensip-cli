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
    const resolved = resolveReportFailure({
      error: new Error('Authorization: Bearer should-not-leak'),
    });
    expect(resolved.exitCode).toBe(EXIT_CODES.RUNTIME_ERROR);
    expect(resolved.message).toBe('The operation failed.');
    expect(JSON.stringify(resolved)).not.toContain('should-not-leak');
  });

  it('normalizes bare non-Error throwables to runtime error failures', () => {
    expect(resolveReportFailure({ error: 'string boom' })).toMatchObject({
      exitCode: EXIT_CODES.RUNTIME_ERROR,
      message: 'An unexpected internal failure occurred.',
    });
    expect(resolveReportFailure({ error: 42 })).toMatchObject({
      exitCode: EXIT_CODES.RUNTIME_ERROR,
      message: 'An unexpected internal failure occurred.',
    });
    expect(resolveReportFailure({ error: { reason: 'plain' } })).toMatchObject({
      exitCode: EXIT_CODES.RUNTIME_ERROR,
      message: 'An unexpected internal failure occurred.',
    });
  });

  it('does not surface oversized operator-only throwable messages', () => {
    const resolved = resolveReportFailure({
      error: new Error('x'.repeat(2000)),
    });
    expect(resolved.exitCode).toBe(EXIT_CODES.RUNTIME_ERROR);
    expect(resolved.message).toBe('The operation failed.');
    expect(JSON.stringify(resolved)).not.toContain('x'.repeat(100));
  });

  it('preserves ToolError code and canonical mapped exit code', () => {
    const resolved = resolveReportFailure({
      error: new NotFoundError('missing'),
    });
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
    expect(resolved).toMatchObject({
      message: 'custom',
      exitCode: 9,
      code: 'CUSTOM',
    });
  });

  it('bounds and scrubs explicit customer-facing overrides', () => {
    const resolved = resolveReportFailure({
      message: `Authorization: Bearer abc123 ${'x'.repeat(2000)}`,
      suggestion: `api_key=top-secret ${'y'.repeat(2000)}`,
      exitCode: 1,
    });
    expect(resolved.message.length).toBeLessThanOrEqual(1000);
    expect(resolved.message.endsWith('...')).toBe(true);
    expect(resolved.message).not.toContain('abc123');
    expect(resolved.suggestion).not.toContain('top-secret');
  });

  it('rejects invalid explicit exit values instead of handing them to process.exitCode', () => {
    expect(() => resolveReportFailure({ message: 'bad', exitCode: Number.NaN })).toThrow(
      SystemError,
    );
    expect(() => resolveReportFailure({ message: 'bad', exitCode: 999 })).toThrow(SystemError);
  });

  it('reads report details without invoking hostile accessors', () => {
    const read = vi.fn(() => 'leak');
    const detail = { exitCode: 1 } as Record<string, unknown>;
    Object.defineProperty(detail, 'message', { enumerable: true, get: read });
    expect(() => resolveReportFailure(detail as never)).toThrow(SystemError);
    expect(read).not.toHaveBeenCalled();
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
    expect(deps.render).toHaveBeenCalledWith({
      type: 'error',
      message: 'nope',
      exitCode: 2,
    });
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
    await report({
      message: 'nope',
      exitCode: 3,
      jsonRequested: true,
      code: 'not-found',
    });
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
        message: 'bad configuration',
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
      expect.objectContaining({
        evt: 'tool.command.failed',
        message: 'failed',
        exitCode: 1,
      }),
    );
  });

  it('keeps caller log data nested so reserved host fields cannot be overwritten', async () => {
    const deps = makeReportFailureDeps();
    const report = createReportFailure({
      getLogger: deps.getLogger,
      setExitCode: deps.setExitCode,
      render: deps.render,
      emitError: deps.emitError,
      writeStderr: deps.writeStderr,
    });
    await report({
      message: 'primary',
      exitCode: 1,
      log: {
        evt: 'plugin.failure',
        data: { evt: 'forged', module: 'forged', exitCode: 0, token: 'secret-token-value' },
      },
    });
    expect(deps.log.warn).toHaveBeenCalledWith({
      evt: 'plugin.failure',
      module: 'cli:report-failure',
      message: 'primary',
      exitCode: 1,
      data: expect.objectContaining({ evt: 'forged', module: 'forged', exitCode: 0 }),
    });
    expect(JSON.stringify(deps.log.warn.mock.calls)).not.toContain('secret-token-value');
  });

  it('preserves the primary exit and resolves when every secondary sink fails', async () => {
    const setExitCode = vi.fn(() => {
      throw new Error('exit holder unavailable');
    });
    const writeStderr = vi.fn(() => {
      throw new Error('broken stderr');
    });
    const report = createReportFailure({
      getLogger: () => {
        throw new Error('logger unavailable');
      },
      setExitCode,
      render: () => Promise.reject(new Error('renderer unavailable')),
      emitError: () => {
        throw new Error('json sink unavailable');
      },
      writeStderr,
      getDiagnostics: () => {
        throw new Error('diagnostics unavailable');
      },
    });

    await expect(report({ message: 'primary', exitCode: 4 })).resolves.toBeUndefined();
    expect(setExitCode).toHaveBeenCalledWith(4);
    expect(writeStderr).toHaveBeenCalledTimes(1);
  });

  it('sanitizes diagnostic fields before stderr rendering', async () => {
    const deps = makeReportFailureDeps();
    const report = createReportFailure({
      getLogger: deps.getLogger,
      setExitCode: deps.setExitCode,
      render: deps.render,
      emitError: deps.emitError,
      writeStderr: deps.writeStderr,
    });
    await report({
      message: 'diagnostic failure',
      exitCode: 2,
      diagnostic: {
        severity: 'error',
        code: 'CONFIG.BAD',
        category: 'configuration',
        message: 'Authorization: Bearer abc123',
        impact: 'token=hidden-value',
      },
    });
    expect(JSON.stringify(deps.writeStderr.mock.calls)).not.toContain('abc123');
    expect(JSON.stringify(deps.writeStderr.mock.calls)).not.toContain('hidden-value');
  });
});
