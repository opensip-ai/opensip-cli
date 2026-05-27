import { describe, it, expect, vi, afterEach } from 'vitest';

import * as openDashboardMod from '../open-dashboard.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('maybeOpenDashboard', () => {
  it('does nothing when openRequested is false', async () => {
    const launch = vi.spyOn(openDashboardMod, 'launchBrowser');
    const mod = await import('../bootstrap/dashboard.js');
    await mod.maybeOpenDashboard({ openRequested: false, jsonOutput: false });
    expect(launch).not.toHaveBeenCalled();
  });

  it('does nothing in JSON mode', async () => {
    const launch = vi.spyOn(openDashboardMod, 'launchBrowser');
    const mod = await import('../bootstrap/dashboard.js');
    await mod.maybeOpenDashboard({ openRequested: true, jsonOutput: true });
    expect(launch).not.toHaveBeenCalled();
  });
});
