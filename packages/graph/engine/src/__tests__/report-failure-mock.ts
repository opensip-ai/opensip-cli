import { mapToolErrorToExitCode } from '@opensip-cli/contracts';
import { vi } from 'vitest';

import type { ToolError } from '@opensip-cli/core';

/** Vitest stub that mirrors host {@link ToolCliContext.reportFailure} fan-out. */
export function makeReportFailureMock(
  setExitCode: (code: number) => void,
  render?: (result: unknown) => Promise<void>,
) {
  return vi.fn(async (detail: { exitCode?: number; error?: ToolError; message?: string }) => {
    let code = detail.exitCode;
    if (code === undefined && detail.error !== undefined) {
      code = mapToolErrorToExitCode(detail.error);
    }
    if (code !== undefined) {
      setExitCode(code);
    }
    const message = detail.message ?? detail.error?.message ?? '';
    if (message && render !== undefined) {
      await render({ type: 'error', message, exitCode: code ?? 1 });
    }
  });
}
