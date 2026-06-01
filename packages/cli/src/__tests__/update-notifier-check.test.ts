/**
 * Coverage for the `checkForUpdate` "an update is available" and "the
 * notifier threw" branches, which the environment-dependent test in
 * update-notifier.test.ts can't force. We mock the upstream
 * `update-notifier` package so `notifier.update` is deterministic.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Controlled by each test before calling checkForUpdate. `undefined` ⇒ the
// notifier reports no update; an object ⇒ that update; throwing is handled
// via mockImplementationOnce below.
let fakeUpdate: { latest: string; current: string } | undefined;

vi.mock('update-notifier', () => ({
  default: vi.fn(() => ({ update: fakeUpdate })),
}));

const savedTTY = process.stdout.isTTY;

beforeEach(() => {
  delete process.env.OPENSIP_NO_UPDATE;
  delete process.env.NO_UPDATE_NOTIFIER;
  fakeUpdate = undefined;
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
  vi.resetModules();
});

afterEach(() => {
  Object.defineProperty(process.stdout, 'isTTY', { value: savedTTY, configurable: true });
  vi.restoreAllMocks();
});

describe('checkForUpdate (mocked notifier)', () => {
  it('returns the latest version when npm reports a genuinely newer release', async () => {
    fakeUpdate = { latest: '9.9.9', current: '1.0.0' };
    const { checkForUpdate } = await import('../update-notifier.js');
    expect(checkForUpdate({ name: 'opensip-tools', version: '1.0.0' })).toBe('9.9.9');
  });

  it('returns undefined when the reported latest is not newer', async () => {
    fakeUpdate = { latest: '1.0.0', current: '2.0.0' };
    const { checkForUpdate } = await import('../update-notifier.js');
    expect(checkForUpdate({ name: 'opensip-tools', version: '2.0.0' })).toBeUndefined();
  });

  it('degrades silently to undefined when the notifier throws', async () => {
    const updateNotifierMod = await import('update-notifier');
    const notifier = updateNotifierMod.default as unknown as ReturnType<typeof vi.fn>;
    notifier.mockImplementationOnce(() => {
      throw new Error('corrupt update cache');
    });
    const { checkForUpdate } = await import('../update-notifier.js');
    expect(checkForUpdate({ name: 'opensip-tools', version: '1.0.0' })).toBeUndefined();
  });
});
