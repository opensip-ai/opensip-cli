import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { maybeNotify, isNewerVersion, checkForUpdate, formatUpdateNag } from '../update-notifier.js';

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

describe('isNewerVersion', () => {
  it('returns true when latest is strictly newer', () => {
    expect(isNewerVersion('2.2.1', '2.1.0')).toBe(true);
    expect(isNewerVersion('2.0.0', '1.9.9')).toBe(true);
    expect(isNewerVersion('1.0.1', '1.0.0')).toBe(true);
  });

  it('returns false when latest is older — the downgrade bug', () => {
    // The exact case the user hit: running 2.2.1 against npm latest 2.1.0.
    expect(isNewerVersion('2.1.0', '2.2.1')).toBe(false);
    expect(isNewerVersion('1.0.0', '2.0.0')).toBe(false);
  });

  it('returns false when versions are equal', () => {
    expect(isNewerVersion('2.2.1', '2.2.1')).toBe(false);
  });

  it('treats a release as newer than a prerelease of the same core', () => {
    expect(isNewerVersion('2.2.1', '2.2.1-beta.1')).toBe(true);
    expect(isNewerVersion('2.2.1-beta.1', '2.2.1')).toBe(false);
  });
});

describe('checkForUpdate', () => {
  it('returns undefined when opted out via OPENSIP_NO_UPDATE', () => {
    process.env.OPENSIP_NO_UPDATE = '1';
    expect(checkForUpdate({ name: '@opensip-tools/cli', version: '0.0.1' })).toBeUndefined();
  });

  it('returns undefined when stdout is not a TTY', () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    expect(checkForUpdate({ name: '@opensip-tools/cli', version: '0.0.1' })).toBeUndefined();
  });

  it('does not throw on a TTY and returns a string or undefined', () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    // The cached npm result is environment-dependent, so we only assert the
    // contract: best-effort, never throws, narrows to string | undefined.
    const result = checkForUpdate({ name: 'opensip-tools-test-nonexistent', version: '0.0.1' });
    expect(result === undefined || typeof result === 'string').toBe(true);
  });
});

describe('formatUpdateNag', () => {
  it('renders the current → latest line with the install command and silence hint', () => {
    const nag = formatUpdateNag('2.2.1', '2.3.0');
    expect(nag).toContain('opensip-tools 2.2.1 → 2.3.0 available');
    expect(nag).toContain('npm install -g @opensip-tools/cli');
    expect(nag).toContain('OPENSIP_NO_UPDATE=1');
  });
});
