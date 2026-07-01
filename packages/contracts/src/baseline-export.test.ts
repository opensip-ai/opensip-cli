import { ConfigurationError } from '@opensip-cli/core';
import { describe, expect, it, vi } from 'vitest';

import { runBaselineExport } from './baseline-export.js';
import { EXIT_CODES } from './exit-codes.js';

import type { ToolCliContext } from '@opensip-cli/core';

function cliStub() {
  const emitJson = vi.fn();
  const reportFailure = vi.fn(() => Promise.resolve());
  const cli = { emitJson, reportFailure } as unknown as ToolCliContext;
  return { cli, emitJson, reportFailure };
}

describe('runBaselineExport', () => {
  it('emits the command result on the json path after writing the artifact', async () => {
    const { cli, emitJson } = cliStub();
    const exportArtifact = vi.fn(() => Promise.resolve());
    const writeTextSync = vi.fn();
    const result = { type: 'baseline-export', outPath: 'out.json' };

    await runBaselineExport({
      cli,
      outPath: 'out.json',
      jsonRequested: true,
      result,
      exportArtifact,
      writeTextSync,
    });

    expect(exportArtifact).toHaveBeenCalledOnce();
    expect(emitJson).toHaveBeenCalledWith(result);
    expect(writeTextSync).not.toHaveBeenCalled();
  });

  it('writes the plain status line on the non-json path', async () => {
    const { cli, emitJson } = cliStub();
    const writeTextSync = vi.fn();

    await runBaselineExport({
      cli,
      outPath: 'baseline.sarif',
      jsonRequested: false,
      result: { type: 'fit-baseline-export', outPath: 'baseline.sarif' },
      exportArtifact: () => Promise.resolve(),
      writeTextSync,
    });

    expect(writeTextSync).toHaveBeenCalledWith('baseline.sarif');
    expect(emitJson).not.toHaveBeenCalled();
  });

  it('maps a missing baseline ConfigurationError to a configuration failure', async () => {
    const { cli, reportFailure } = cliStub();
    const onFailure = vi.fn();

    await runBaselineExport({
      cli,
      outPath: 'baseline.json',
      jsonRequested: true,
      result: { type: 'graph-baseline-export', outPath: 'baseline.json' },
      exportArtifact: () => Promise.reject(new ConfigurationError('No baseline captured')),
      writeTextSync: vi.fn(),
      onFailure,
    });

    expect(onFailure).toHaveBeenCalledWith({
      message: 'No baseline captured',
      exitCode: EXIT_CODES.CONFIGURATION_ERROR,
      error: expect.any(ConfigurationError),
    });
    expect(reportFailure).toHaveBeenCalledWith({
      message: 'No baseline captured',
      exitCode: EXIT_CODES.CONFIGURATION_ERROR,
      jsonRequested: true,
    });
  });
});
