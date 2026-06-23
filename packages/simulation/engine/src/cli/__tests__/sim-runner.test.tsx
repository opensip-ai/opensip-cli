/**
 * @fileoverview Tests for the sim live-view entry (cli-live shell).
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

import { renderSimLive } from '../sim-runner.js';

const runToolLiveView = vi.hoisted(() => vi.fn());

vi.mock('@opensip-cli/cli-live', () => ({
  runToolLiveView,
}));

describe('renderSimLive', () => {
  beforeEach(() => {
    runToolLiveView.mockReset();
    runToolLiveView.mockResolvedValue({ envelope: undefined, session: undefined });
  });

  it('routes through runToolLiveView with the sim tool key', async () => {
    await renderSimLive({ cwd: '/proj', recipe: 'example', json: false, debug: false });
    expect(runToolLiveView).toHaveBeenCalledTimes(1);
    const [spec] = runToolLiveView.mock.calls[0] as [{ tool: string }];
    expect(spec.tool).toBe('sim');
  });
});
