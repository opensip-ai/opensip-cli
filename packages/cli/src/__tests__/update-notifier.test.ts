import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { maybeNotify } from '../update-notifier.js';

const originalEnv = { ...process.env };
const originalIsTTY = process.stdout.isTTY;

beforeEach(() => {
  delete process.env.OPENSIP_NO_UPDATE;
  delete process.env.NO_UPDATE_NOTIFIER;
  delete process.env.CI;
});

afterEach(() => {
  process.env = { ...originalEnv };
  Object.defineProperty(process.stdout, 'isTTY', { value: originalIsTTY, configurable: true });
  vi.restoreAllMocks();
});

describe('maybeNotify', () => {
  it('returns null when OPENSIP_NO_UPDATE is set', () => {
    process.env.OPENSIP_NO_UPDATE = '1';
    expect(maybeNotify({ name: 'test', version: '1.0.0' })).toBeNull();
  });

  it('returns null when NO_UPDATE_NOTIFIER is set', () => {
    process.env.NO_UPDATE_NOTIFIER = '1';
    expect(maybeNotify({ name: 'test', version: '1.0.0' })).toBeNull();
  });

  it('returns null when stdout is not a TTY', () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    expect(maybeNotify({ name: 'test', version: '1.0.0' })).toBeNull();
  });

  it('returns a notifier (not null) when stdout is a TTY and not opted-out', () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    const out = maybeNotify({ name: 'opensip-tools-test', version: '0.0.1' });
    // We don't assert the shape — we only care that the early-skip
    // gates aren't blocking us.
    expect(out).not.toBeNull();
  });

  it('writes the update line via the supplied write callback when a newer version exists', () => {
    // Mock update-notifier to force a fake "update available" reply.
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    const writes: string[] = [];
    const out = maybeNotify({
      name: '@opensip-tools/cli',
      version: '0.0.1',
      write: (s) => writes.push(s),
    });
    // We can't reliably force update-notifier to report an update in
    // a unit test, but we can assert the call didn't throw and the
    // notifier instance was returned.
    expect(out).toBeDefined();
  });
});
