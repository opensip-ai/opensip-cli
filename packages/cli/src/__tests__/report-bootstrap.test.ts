import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

import * as openReportMod from '../open-report.js';
import * as composeMod from '../report-compose.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('maybeOpenReport', () => {
  it('does nothing when openRequested is false', async () => {
    const launch = vi.spyOn(openReportMod, 'launchReport');
    const mod = await import('../bootstrap/report.js');
    await mod.maybeOpenReport({ openRequested: false, jsonOutput: false });
    expect(launch).not.toHaveBeenCalled();
  });

  it('does nothing in JSON mode', async () => {
    const launch = vi.spyOn(openReportMod, 'launchReport');
    const mod = await import('../bootstrap/report.js');
    await mod.maybeOpenReport({ openRequested: true, jsonOutput: true });
    expect(launch).not.toHaveBeenCalled();
  });

  describe('when the open conditions allow it', () => {
    const savedEnv = { ...process.env };
    const savedTTY = process.stdout.isTTY;

    beforeEach(() => {
      // decideReportOpen wants: openRequested, not json, stdout TTY, not CI, and
      // not an SSH session without a display.
      delete process.env.CI;
      delete process.env.SSH_CONNECTION;
      delete process.env.SSH_CLIENT;
      Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    });

    afterEach(() => {
      process.env = { ...savedEnv };
      Object.defineProperty(process.stdout, 'isTTY', { value: savedTTY, configurable: true });
    });

    it('composes and opens the cross-tool dashboard', async () => {
      const compose = vi
        .spyOn(composeMod, 'composeAndWriteReport')
        .mockResolvedValue({ type: 'report', path: 'reports/latest.html', opened: true });
      const mod = await import('../bootstrap/report.js');
      await mod.maybeOpenReport({ openRequested: true, jsonOutput: false });
      expect(compose).toHaveBeenCalledWith({ open: true });
    });
  });
});
