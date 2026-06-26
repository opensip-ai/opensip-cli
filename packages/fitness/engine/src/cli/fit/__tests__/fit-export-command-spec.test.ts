/**
 * fit-export-command-spec — the canonical `fit export --format baseline` command.
 * These tests assert: (1) the canonical spec dispatches `--format baseline` to
 * the host baseline SARIF seam; (2) it surfaces the ConfigurationError "no
 * baseline" path (exit 2 + stderr / --json). The legacy flat-root
 * `fit-baseline-export` alias was removed.
 */

import { ConfigurationError } from '@opensip-cli/core';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { fitnessTool } from '../../../tool.js';
import { fitExportCommandSpec, FIT_EXPORT_FORMATS } from '../fit-aux-command-specs.js';

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
  reportFailure: MockInstance;
}

function makeCli(exportImpl?: () => Promise<void>): MockBag {
  const exportBaselineSarif = vi.fn(exportImpl ?? (() => Promise.resolve()));
  const emitJson = vi.fn();
  const reportFailure = vi.fn(() => Promise.resolve());
  const cli = {
    exportBaselineSarif,
    emitJson,
    reportFailure,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as ToolCliContext;
  return { cli, exportBaselineSarif, emitJson, reportFailure };
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
  it('is a nested command draft normalized under the fitness primary', () => {
    expect(fitExportCommandSpec.name).toBe('export');
    expect(fitExportCommandSpec.parent).toBeUndefined();
    const normalized = fitnessTool.commandSpecs?.find((spec) => spec.name === 'export');
    expect(normalized?.parent).toBe('fitness');
    expect(FIT_EXPORT_FORMATS).toContain('baseline');
  });

  it('--format baseline writes the SARIF baseline via the host seam', async () => {
    const { cli, exportBaselineSarif } = makeCli();
    await fitExportCommandSpec.handler({ format: 'baseline', out: OUT_PATH, _args: [] }, cli);
    expect(exportBaselineSarif).toHaveBeenCalledWith('fitness', OUT_PATH);
    const out = stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(out).toContain('Exported fit baseline');
  });

  it('maps the ConfigurationError "no baseline" path to reportFailure exit 2', async () => {
    const { cli, reportFailure } = makeCli(() =>
      Promise.reject(new ConfigurationError('No fit baseline captured')),
    );
    await fitExportCommandSpec.handler({ format: 'baseline', out: OUT_PATH, _args: [] }, cli);
    expect(reportFailure).toHaveBeenCalledWith({
      message: 'No fit baseline captured',
      exitCode: 2,
      jsonRequested: false,
    });
  });

  it('routes --json + missing baseline through reportFailure', async () => {
    const { cli, reportFailure } = makeCli(() =>
      Promise.reject(new ConfigurationError('No fit baseline captured')),
    );
    await fitExportCommandSpec.handler(
      { format: 'baseline', out: OUT_PATH, json: true, _args: [] },
      cli,
    );
    expect(reportFailure).toHaveBeenCalledWith({
      message: 'No fit baseline captured',
      exitCode: 2,
      jsonRequested: true,
    });
  });
});
