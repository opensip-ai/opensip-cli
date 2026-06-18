/**
 * fit-export-command-spec — the canonical `fit export --format baseline` command
 * (tool-command-surface-taxonomy Task 2.2) and its legacy `fit-baseline-export`
 * alias share ONE handler body (`runFitBaselineExport`, exercised via both specs
 * here). These tests assert: (1) the canonical spec dispatches `--format
 * baseline` to the host baseline SARIF seam; (2) the legacy alias emits
 * `legacy_alias_used` telemetry and the SAME seam call; (3) both surface the
 * ConfigurationError "no baseline" path identically (exit 2 + stderr / --json).
 */

import { ConfigurationError, logger } from '@opensip-cli/core';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import {
  fitBaselineExportCommandSpec,
  fitExportCommandSpec,
  FIT_EXPORT_FORMATS,
} from '../fit-aux-command-specs.js';

import type { ToolCliContext } from '@opensip-cli/core';

/**
 * A sentinel output path threaded to the handler. It is NEVER written: the
 * `exportBaselineSarif` seam is mocked, so the handler only forwards this value
 * — using a non-`/tmp` relative path avoids the sonarjs publicly-writable-dir
 * rule while exercising the exact argument passed to the seam.
 */
const OUT_PATH = 'out/fit-baseline.sarif';

interface MockBag {
  cli: ToolCliContext;
  exportBaselineSarif: MockInstance;
  emitJson: MockInstance;
  emitError: MockInstance;
  setExitCode: MockInstance;
}

function makeCli(exportImpl?: () => Promise<void>): MockBag {
  const exportBaselineSarif = vi.fn(exportImpl ?? (() => Promise.resolve()));
  const emitJson = vi.fn();
  const emitError = vi.fn();
  const setExitCode = vi.fn();
  const cli = {
    exportBaselineSarif,
    emitJson,
    emitError,
    setExitCode,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as ToolCliContext;
  return { cli, exportBaselineSarif, emitJson, emitError, setExitCode };
}

let stdoutSpy: MockInstance<typeof process.stdout.write>;
let stderrSpy: MockInstance<typeof process.stderr.write>;

beforeEach(() => {
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterEach(() => {
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
  vi.restoreAllMocks();
});

describe('fit export (canonical) command spec', () => {
  it('is a nested child of the fit primary (parent: fit, name: export)', () => {
    expect(fitExportCommandSpec.name).toBe('export');
    expect(fitExportCommandSpec.parent).toBe('fit');
    expect(FIT_EXPORT_FORMATS).toContain('baseline');
  });

  it('--format baseline writes the SARIF baseline via the host seam', async () => {
    const { cli, exportBaselineSarif } = makeCli();
    await fitExportCommandSpec.handler({ format: 'baseline', out: OUT_PATH, _args: [] }, cli);
    expect(exportBaselineSarif).toHaveBeenCalledWith('fitness', OUT_PATH);
    const out = stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(out).toContain('Exported fit baseline');
  });

  it('maps the ConfigurationError "no baseline" path to exit 2 + stderr', async () => {
    const { cli, setExitCode } = makeCli(() =>
      Promise.reject(new ConfigurationError('No fit baseline captured')),
    );
    await fitExportCommandSpec.handler({ format: 'baseline', out: OUT_PATH, _args: [] }, cli);
    expect(setExitCode).toHaveBeenCalledWith(2);
    const err = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(err).toContain('Error');
  });

  it('emits a structured error on --json + missing baseline', async () => {
    const { cli, emitError, setExitCode } = makeCli(() =>
      Promise.reject(new ConfigurationError('No fit baseline captured')),
    );
    await fitExportCommandSpec.handler(
      { format: 'baseline', out: OUT_PATH, json: true, _args: [] },
      cli,
    );
    // 2.12.0 (§5.5): the --json failure path routes through `emitError` (the host
    // wraps it in a status:'error' CommandOutcome + sets the exit code from the
    // payload), NOT a direct `setExitCode` in the handler.
    expect(setExitCode).not.toHaveBeenCalled();
    expect(emitError.mock.calls.length).toBe(1);
    const payload = emitError.mock.calls[0]?.[0] as { exitCode?: number };
    expect(payload?.exitCode).toBe(2);
  });
});

describe('fit-baseline-export (legacy alias) command spec', () => {
  it('emits legacy_alias_used telemetry and calls the SAME host seam', async () => {
    const { cli, exportBaselineSarif } = makeCli();
    // The legacy handler logs via the module logger from @opensip-cli/core.
    const loggerInfo = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    await fitBaselineExportCommandSpec.handler({ out: OUT_PATH, _args: [] }, cli);
    expect(exportBaselineSarif).toHaveBeenCalledWith('fitness', OUT_PATH);
    const evt = loggerInfo.mock.calls.find(
      (c) => (c[0] as { evt?: string }).evt === 'cli.command.legacy_alias_used',
    );
    expect(evt, 'legacy_alias_used telemetry must be emitted').toBeDefined();
    expect((evt?.[0] as { legacyCommand?: string }).legacyCommand).toBe('fit-baseline-export');
    expect((evt?.[0] as { canonical?: string }).canonical).toBe('fit export --format baseline');
  });
});
