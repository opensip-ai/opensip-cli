/**
 * Tests for the catch handler that processes errors thrown out of
 * `program.parseAsync()`. Covers:
 *   - typed errors from `@opensip-cli/core` map to the right exit
 *     code via `instanceof`
 *   - unknown errors fall back to `getErrorSuggestion`
 *   - the catch handler always routes through `setExitCode` rather
 *     than touching `process.exitCode` directly
 *   - rendering goes through the supplied `ErrorResult` renderer
 */

import { EXIT_CODES, type ErrorResult } from '@opensip-cli/contracts';
import {
  ConfigurationError,
  NetworkError,
  NotFoundError,
  PluginIncompatibleError,
  ValidationError,
} from '@opensip-cli/core';
import { CommanderError } from 'commander';
import { describe, expect, it, vi } from 'vitest';

import { BootstrapError } from '../bootstrap/bootstrap-error.js';
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
    expect(opts.rendered[0]?.suggestion).toContain('opensip-cli.config.yml');
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

  it('typed mapper wins over a coincidental substring match (M7: typed is authoritative)', async () => {
    const opts = makeOpts();
    // The message contains 'fetch', which getErrorSuggestion's network rule would
    // otherwise map to REPORT_FAILED (4). Because this is a typed ValidationError,
    // the typed mapper must win → CONFIGURATION_ERROR (2). This guards the
    // `typed ?? getErrorSuggestion` precedence against regression.
    await handleParseError(new ValidationError('could not fetch the manifest'), opts);
    expect(opts.setExitCode).toHaveBeenCalledWith(EXIT_CODES.CONFIGURATION_ERROR);
    expect(opts.rendered[0]?.exitCode).toBe(EXIT_CODES.CONFIGURATION_ERROR);
  });

  it('uses getErrorSuggestion for advice but keeps untyped errors at RUNTIME_ERROR (Unknown recipe)', async () => {
    const opts = makeOpts();
    await handleParseError(new Error("Unknown recipe 'foo'"), opts);
    expect(opts.setExitCode).toHaveBeenCalledWith(EXIT_CODES.RUNTIME_ERROR);
    expect(opts.rendered[0]?.suggestion).toContain('--recipes');
  });

  it('untyped Check not found exits RUNTIME_ERROR while typed NotFoundError exits CHECK_NOT_FOUND', async () => {
    const untyped = makeOpts();
    await handleParseError(new Error('Check not found: foo'), untyped);
    expect(untyped.setExitCode).toHaveBeenCalledWith(EXIT_CODES.RUNTIME_ERROR);

    const typed = makeOpts();
    await handleParseError(new NotFoundError('Check not found: foo'), typed);
    expect(typed.setExitCode).toHaveBeenCalledWith(EXIT_CODES.CHECK_NOT_FOUND);
  });

  it('untyped Bad YAML may show a suggestion but exits RUNTIME_ERROR', async () => {
    const opts = makeOpts();
    await handleParseError(new Error('Bad YAML at line 3'), opts);
    expect(opts.setExitCode).toHaveBeenCalledWith(EXIT_CODES.RUNTIME_ERROR);
    expect(opts.rendered[0]?.suggestion).toContain('opensip-cli.config.yml');
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

  it('handleFatalBootstrapError for typed ToolError uses mapToolErrorToExitCode (e.g. PLUGIN_INCOMPATIBLE)', () => {
    const savedExitCode = process.exitCode;
    process.exitCode = 0;
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const errorLog = vi.fn();
    try {
      handleFatalBootstrapError(
        new PluginIncompatibleError('bad bundled', { diagnostic: 'manifest' }),
        { error: errorLog },
      );
    } finally {
      spy.mockRestore();
      process.exitCode = savedExitCode;
    }
    expect(errorLog).toHaveBeenCalledWith(
      expect.objectContaining({ exitCode: EXIT_CODES.PLUGIN_INCOMPATIBLE }),
    );
  });

  // ── Commander exitOverride errors (2.11.0 command plane) ──────────────────
  // The root program calls `.exitOverride()` so Commander's parse failures
  // surface here instead of `process.exit(N)`. Invalid-argument-value codes
  // (declarative `choices` rejection — e.g. `graph --resolution bogus`, whose
  // validation moved out of the handler's `ValidationError`) must re-map to
  // CONFIGURATION_ERROR (2); every other Commander code keeps its own exit code.
  // In all cases Commander already wrote its own line, so the handler renders
  // nothing (no duplicate output).
  it('re-maps commander.invalidArgument to CONFIGURATION_ERROR (2) and renders nothing', async () => {
    const opts = makeOpts();
    const err = new CommanderError(
      1,
      'commander.invalidArgument',
      "error: option '--resolution <mode>' argument 'bogus' is invalid. Allowed choices are exact, fast.",
    );
    await handleParseError(err, opts);
    expect(opts.setExitCode).toHaveBeenCalledWith(EXIT_CODES.CONFIGURATION_ERROR);
    expect(opts.render).not.toHaveBeenCalled();
  });

  it('re-maps commander.invalidOptionArgument to CONFIGURATION_ERROR (2)', async () => {
    const opts = makeOpts();
    const err = new CommanderError(1, 'commander.invalidOptionArgument', 'bad value');
    await handleParseError(err, opts);
    expect(opts.setExitCode).toHaveBeenCalledWith(EXIT_CODES.CONFIGURATION_ERROR);
    expect(opts.render).not.toHaveBeenCalled();
  });

  it('preserves commander exit code for unknown-command (1) and renders nothing', async () => {
    const opts = makeOpts();
    const err = new CommanderError(1, 'commander.unknownCommand', "error: unknown command 'nope'");
    await handleParseError(err, opts);
    expect(opts.setExitCode).toHaveBeenCalledWith(1);
    expect(opts.render).not.toHaveBeenCalled();
  });

  it('preserves commander exit code for --help / --version display (0)', async () => {
    const opts = makeOpts();
    await handleParseError(new CommanderError(0, 'commander.helpDisplayed', '(outputHelp)'), opts);
    expect(opts.setExitCode).toHaveBeenCalledWith(0);
    expect(opts.render).not.toHaveBeenCalled();
  });

  it('typed errors take priority over substring suggestions', async () => {
    // ConfigurationError("Unknown recipe 'foo'") matches both the typed
    // rule (via instanceof) and the substring rule (via the message).
    // The typed rule must win — that's the whole point of Phase 4.
    const opts = makeOpts();
    await handleParseError(new ConfigurationError("Unknown recipe 'foo'"), opts);
    // The typed-rule suggestion mentions opensip-cli.config.yml, the
    // substring rule mentions --recipes. We assert the typed-rule
    // suggestion wins.
    expect(opts.rendered[0]?.suggestion).toContain('opensip-cli.config.yml');
  });

  // Task 1 focused matrix coverage (composition-root-hardening): Commander parse,
  // typed ToolError subclasses (incl. PluginIncompatible), BootstrapError,
  // unknown, non-Error. Report-upload vs findings lives in deliver + exit-parity.
  it('routes PluginIncompatibleError (typed ToolError) to PLUGIN_INCOMPATIBLE exit', async () => {
    const opts = makeOpts();
    await handleParseError(new PluginIncompatibleError('bad plugin', { diagnostic: 'x' }), opts);
    expect(opts.setExitCode).toHaveBeenCalledWith(EXIT_CODES.PLUGIN_INCOMPATIBLE);
    expect(opts.rendered[0]?.exitCode).toBe(EXIT_CODES.PLUGIN_INCOMPATIBLE);
  });
});

// 2.12.0 (§4.7 / §5.5): BootstrapError + the --json structured-outcome path.
function spyStreams(): { stdout: string[]; stderr: string[]; restore: () => void } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const o = vi.spyOn(process.stdout, 'write').mockImplementation((c) => {
    stdout.push(String(c));
    return true;
  });
  const e = vi.spyOn(process.stderr, 'write').mockImplementation((c) => {
    stderr.push(String(c));
    return true;
  });
  return {
    stdout,
    stderr,
    restore: () => {
      o.mockRestore();
      e.mockRestore();
    },
  };
}

const bootstrapErr = (): BootstrapError =>
  new BootstrapError({
    message: 'No project found.',
    humanMessage: '✗ No project found.\n  Run init.',
    suggestion: 'Run opensip init.',
    exitCode: 2,
  });

describe('handleParseError — 2.12.0 outcomes', () => {
  it('renders a BootstrapError to stderr verbatim (human mode), exit from the error', async () => {
    const opts = { ...makeOpts(), jsonRequested: false };
    const s = spyStreams();
    try {
      await handleParseError(bootstrapErr(), opts);
    } finally {
      s.restore();
    }
    expect(opts.setExitCode).toHaveBeenCalledWith(2);
    expect(s.stderr.join('')).toContain('✗ No project found.');
    expect(opts.rendered).toHaveLength(0); // no Ink render for bootstrap errors
  });

  it('emits a structured bootstrap.error CommandOutcome on --json', async () => {
    const opts = { ...makeOpts(), jsonRequested: true };
    const s = spyStreams();
    try {
      await handleParseError(bootstrapErr(), opts);
    } finally {
      s.restore();
    }
    expect(opts.setExitCode).toHaveBeenCalledWith(2);
    const outcome = JSON.parse(s.stdout.join('')) as {
      kind: string;
      status: string;
      errors: { message: string; suggestion?: string }[];
    };
    expect(outcome.kind).toBe('bootstrap.error');
    expect(outcome.status).toBe('error');
    expect(outcome.errors[0]?.message).toBe('No project found.');
    expect(outcome.errors[0]?.suggestion).toBe('Run opensip init.');
  });

  it('emits a structured command.error CommandOutcome for a generic error on --json', async () => {
    const opts = { ...makeOpts(), jsonRequested: true };
    const s = spyStreams();
    try {
      await handleParseError(new NotFoundError('Check not found: foo'), opts);
    } finally {
      s.restore();
    }
    expect(opts.setExitCode).toHaveBeenCalledWith(EXIT_CODES.CHECK_NOT_FOUND);
    const outcome = JSON.parse(s.stdout.join('')) as {
      kind: string;
      status: string;
      errors: { message: string }[];
    };
    expect(outcome.kind).toBe('command.error');
    expect(outcome.errors[0]?.message).toContain('not found');
    expect(opts.rendered).toHaveLength(0); // JSON path never renders Ink
  });
});
