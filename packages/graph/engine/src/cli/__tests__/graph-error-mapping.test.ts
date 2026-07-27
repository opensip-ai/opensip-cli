import { EXIT_CODES } from '@opensip-cli/contracts';
import {
  coreSystemErrorCatalog,
  NotFoundError,
  PluginIncompatibleError,
  ToolError,
} from '@opensip-cli/core';
import { describe, expect, it, vi } from 'vitest';

import { handleGraphError } from '../graph.js';

import type { ToolCliContext } from '@opensip-cli/core';

function context(reportFailure: ReturnType<typeof vi.fn>): ToolCliContext {
  return { reportFailure } as unknown as ToolCliContext;
}

describe('handleGraphError', () => {
  it.each([
    [new NotFoundError('missing'), EXIT_CODES.CHECK_NOT_FOUND],
    [new PluginIncompatibleError('bad plugin'), EXIT_CODES.PLUGIN_INCOMPATIBLE],
    [
      new ToolError(
        coreSystemErrorCatalog.require('CORE.SYSTEM.CANCELLED'),
        'cancelled by operator',
      ),
      EXIT_CODES.CANCELLED,
    ],
  ])('uses the canonical host exit mapping for %s', async (error, exitCode) => {
    const reportFailure = vi.fn(() => Promise.resolve());

    await handleGraphError('graph', error, context(reportFailure));

    expect(reportFailure).toHaveBeenCalledWith(
      expect.objectContaining({ error, exitCode, message: `graph: ${error.message}` }),
    );
  });
});
