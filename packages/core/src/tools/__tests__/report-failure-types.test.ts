import { describe, expect, it } from 'vitest';

import type { ReportFailureDetail } from '../report-failure.js';

describe('ReportFailureDetail', () => {
  it('is importable from the public core tools surface', async () => {
    const barrel = await import('../../index.js');
    const lib = await import('../../index-lib.js');
    const detail: ReportFailureDetail = {
      message: 'failed',
      exitCode: 2,
      log: { evt: 'mytool.command.failed', data: { reason: 'missing file' } },
    };
    expect(detail.message).toBe('failed');
    expect(barrel).toHaveProperty('createToolLogger');
    expect(lib).toHaveProperty('createToolLogger');
  });

  it('log.data convention excludes functions at the type level', () => {
    const detail: ReportFailureDetail = {
      message: 'x',
      exitCode: 1,
      log: { evt: 'evt', data: { count: 1, ok: true } },
    };
    expect(detail.log?.data).toEqual({ count: 1, ok: true });
  });
});
