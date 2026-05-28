/**
 * Tests for the catch handler that processes errors thrown out of
 * `program.parseAsync()`. Covers:
 *   - typed errors from `@opensip-tools/core` map to the right exit
 *     code via `instanceof`
 *   - unknown errors fall back to `getErrorSuggestion`
 *   - the catch handler always routes through `setExitCode` rather
 *     than touching `process.exitCode` directly
 *   - rendering goes through the supplied `ErrorResult` renderer
 */

import { EXIT_CODES, type ErrorResult } from '@opensip-tools/contracts';
import {
  ConfigurationError,
  NetworkError,
  NotFoundError,
  ValidationError,
} from '@opensip-tools/core';
import { describe, expect, it, vi } from 'vitest';

import { handleFatalBootstrapError, handleParseError } from '../error-handler.js';

function makeOpts(): {
  setExitCode: ReturnType<typeof vi.fn>;
  render: ReturnType<typeof vi.fn>;
  rendered: ErrorResult[];
} {
  const rendered: ErrorResult[] = [];
  const render = vi.fn((result: ErrorResult) => {
    rendered.push(result);
    return Promise.resolve();
  });
  return { setExitCode: vi.fn(), render, rendered };
}

describe('handleParseError', () => {
  it('routes NotFoundError to CHECK_NOT_FOUND exit code', async () => {
    const opts = makeOpts();
    await handleParseError(new NotFoundError('Check not found: foo'), opts);
    expect(opts.setExitCode).toHaveBeenCalledWith(EXIT_CODES.CHECK_NOT_FOUND);
    expect(opts.rendered[0]).toMatchObject({
      type: 'error',
      message: 'Check not found: foo',
      exitCode: EXIT_CODES.CHECK_NOT_FOUND,
    });
  });

  it('routes ConfigurationError to CONFIGURATION_ERROR exit code', async () => {
    const opts = makeOpts();
    await handleParseError(new ConfigurationError('Bad config'), opts);
    expect(opts.setExitCode).toHaveBeenCalledWith(EXIT_CODES.CONFIGURATION_ERROR);
    expect(opts.rendered[0]?.exitCode).toBe(EXIT_CODES.CONFIGURATION_ERROR);
    expect(opts.rendered[0]?.suggestion).toContain('opensip-tools.config.yml');
  });

  it('routes ValidationError to CONFIGURATION_ERROR exit code', async () => {
    const opts = makeOpts();
    await handleParseError(new ValidationError('Bad input'), opts);
    expect(opts.setExitCode).toHaveBeenCalledWith(EXIT_CODES.CONFIGURATION_ERROR);
  });

  it('routes NetworkError to REPORT_FAILED exit code', async () => {
    const opts = makeOpts();
    await handleParseError(new NetworkError('boom'), opts);
    expect(opts.setExitCode).toHaveBeenCalledWith(EXIT_CODES.REPORT_FAILED);
  });

  it('falls back to getErrorSuggestion for substring-shaped errors (Unknown recipe)', async () => {
    const opts = makeOpts();
    await handleParseError(new Error("Unknown recipe 'foo'"), opts);
    expect(opts.setExitCode).toHaveBeenCalledWith(EXIT_CODES.CONFIGURATION_ERROR);
    expect(opts.rendered[0]?.suggestion).toContain('--recipes');
  });

  it('falls back to RUNTIME_ERROR for completely unknown errors', async () => {
    const opts = makeOpts();
    await handleParseError(new Error('totally unrelated'), opts);
    expect(opts.setExitCode).toHaveBeenCalledWith(EXIT_CODES.RUNTIME_ERROR);
    expect(opts.rendered[0]?.message).toBe('totally unrelated');
  });

  it('handles non-Error throwables', async () => {
    const opts = makeOpts();
    await handleParseError('plain string', opts);
    expect(opts.setExitCode).toHaveBeenCalledWith(EXIT_CODES.RUNTIME_ERROR);
    expect(opts.rendered[0]?.message).toBe('plain string');
  });

  it('handleFatalBootstrapError writes to stderr, logs, and sets exitCode=1', () => {
    const savedExitCode = process.exitCode;
    process.exitCode = 0;
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => {
      writes.push(String(c));
      return true;
    });
    const errorLog = vi.fn();
    let observedExitCode: number | string | undefined;
    try {
      handleFatalBootstrapError(new Error('bootstrap exploded'), { error: errorLog });
      observedExitCode = process.exitCode;
    } finally {
      spy.mockRestore();
      process.exitCode = savedExitCode;
    }
    expect(writes.join('')).toContain('bootstrap exploded');
    expect(errorLog).toHaveBeenCalledWith(
      expect.objectContaining({ evt: 'cli.bootstrap.failed', error: 'bootstrap exploded' }),
    );
    expect(observedExitCode).toBe(EXIT_CODES.RUNTIME_ERROR);
  });

  it('handleFatalBootstrapError handles non-Error throws', () => {
    const savedExitCode = process.exitCode;
    process.exitCode = 0;
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const errorLog = vi.fn();
    try {
      handleFatalBootstrapError('plain string', { error: errorLog });
    } finally {
      spy.mockRestore();
      process.exitCode = savedExitCode;
    }
    expect(errorLog).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'plain string', stack: undefined }),
    );
  });

  it('typed errors take priority over substring suggestions', async () => {
    // ConfigurationError("Unknown recipe 'foo'") matches both the typed
    // rule (via instanceof) and the substring rule (via the message).
    // The typed rule must win — that's the whole point of Phase 4.
    const opts = makeOpts();
    await handleParseError(new ConfigurationError("Unknown recipe 'foo'"), opts);
    // The typed-rule suggestion mentions opensip-tools.config.yml, the
    // substring rule mentions --recipes. We assert the typed-rule
    // suggestion wins.
    expect(opts.rendered[0]?.suggestion).toContain('opensip-tools.config.yml');
  });
});
