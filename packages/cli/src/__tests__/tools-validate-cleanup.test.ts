import { existsSync, rmSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const npmInstallIntoHost = vi.fn();

vi.mock('../commands/plugin-host-ops.js', () => ({
  npmInstallIntoHost: (...args: unknown[]) => npmInstallIntoHost(...args),
}));

const { runToolValidation } = await import('../commands/tools/validate.js');

let stagedHost: string | undefined;

beforeEach(() => {
  stagedHost = undefined;
  npmInstallIntoHost.mockReset();
  npmInstallIntoHost.mockImplementation((dir: string) => {
    stagedHost = dir;
    return { ok: false, error: 'fixture install failed' };
  });
});

afterEach(() => {
  if (stagedHost !== undefined) rmSync(stagedHost, { recursive: true, force: true });
});

describe('tools validate staging cleanup', () => {
  it('returns cleanup ownership for a retained staging failure', async () => {
    const { result, cleanup } = await runToolValidation(
      {
        spec: '@fixture/install-failure',
        cwd: process.cwd(),
      },
      { keepStaged: true },
    );

    expect(result.verdict).toBe('failed');
    expect(stagedHost).toBeDefined();
    expect(existsSync(stagedHost ?? '')).toBe(true);

    cleanup();

    expect(existsSync(stagedHost ?? '')).toBe(false);
  });
});
