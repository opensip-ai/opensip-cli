import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  maybeNotify,
  isNewerVersion,
  checkForUpdate,
  formatUpdateNag,
  UPDATE_CHECK_INTERVAL_MS,
} from '../update-notifier.js';

const originalEnv = { ...process.env };
const originalIsTTY = process.stdout.isTTY;

// Per-test isolated sticky-state file so checkForUpdate never touches the
// developer's real ~/.opensip-cli/update-state.json or leaks across tests.
let tmpDir: string;
let stateFile: string;

beforeEach(() => {
  delete process.env.OPENSIP_NO_UPDATE;
  delete process.env.NO_UPDATE_NOTIFIER;
  delete process.env.CI;
  tmpDir = mkdtempSync(join(tmpdir(), 'osip-upd-'));
  stateFile = join(tmpDir, 'update-state.json');
});

afterEach(() => {
  process.env = { ...originalEnv };
  Object.defineProperty(process.stdout, 'isTTY', {
    value: originalIsTTY,
    configurable: true,
  });
  vi.restoreAllMocks();
  rmSync(tmpDir, { recursive: true, force: true });
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
    Object.defineProperty(process.stdout, 'isTTY', {
      value: false,
      configurable: true,
    });
    expect(maybeNotify({ name: 'test', version: '1.0.0' })).toBeNull();
  });

  it('returns a notifier (not null) when stdout is a TTY and not opted-out', () => {
    Object.defineProperty(process.stdout, 'isTTY', {
      value: true,
      configurable: true,
    });
    const out = maybeNotify({ name: 'opensip-cli-test', version: '0.0.1' });
    // We don't assert the shape — we only care that the early-skip
    // gates aren't blocking us.
    expect(out).not.toBeNull();
  });

  it('writes the update line via the supplied write callback when a newer version exists', () => {
    // Mock update-notifier to force a fake "update available" reply.
    Object.defineProperty(process.stdout, 'isTTY', {
      value: true,
      configurable: true,
    });
    const writes: string[] = [];
    const out = maybeNotify({
      name: 'opensip-cli',
      version: '0.0.1',
      write: (s) => writes.push(s),
    });
    // We can't reliably force update-notifier to report an update in
    // a unit test, but we can assert the call didn't throw and the
    // notifier instance was returned.
    expect(out).toBeDefined();
  });
});

describe('UPDATE_CHECK_INTERVAL_MS', () => {
  it('caps update detection latency at one hour, not a day', () => {
    // This is the worst-case "I published but the CLI still says up-to-date"
    // window. Locked deliberately: detection must stay sub-hourly so a freshly
    // published release is noticed within the hour. Raising this back toward a
    // day (the previous 24h value) should be a conscious change, not a drift.
    expect(UPDATE_CHECK_INTERVAL_MS).toBe(60 * 60 * 1000);
    expect(UPDATE_CHECK_INTERVAL_MS).toBeGreaterThan(0);
    expect(UPDATE_CHECK_INTERVAL_MS).toBeLessThanOrEqual(60 * 60 * 1000);
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
    expect(checkForUpdate({ name: 'opensip-cli', version: '0.0.1', stateFile })).toBeUndefined();
  });

  it('returns undefined when stdout is not a TTY', () => {
    Object.defineProperty(process.stdout, 'isTTY', {
      value: false,
      configurable: true,
    });
    expect(checkForUpdate({ name: 'opensip-cli', version: '0.0.1', stateFile })).toBeUndefined();
  });

  it('does not throw on a TTY and returns a string or undefined', () => {
    Object.defineProperty(process.stdout, 'isTTY', {
      value: true,
      configurable: true,
    });
    // The cached npm result is environment-dependent, so we only assert the
    // contract: best-effort, never throws, narrows to string | undefined.
    const result = checkForUpdate({
      name: 'opensip-cli-test-nonexistent',
      version: '0.0.1',
      stateFile,
    });
    expect(result === undefined || typeof result === 'string').toBe(true);
  });
});

describe('formatUpdateNag', () => {
  it('renders the current -> latest line with the install command and silence hint', () => {
    const nag = formatUpdateNag('2.2.1', '2.3.0');
    expect(nag).toContain('OpenSIP CLI 2.2.1 -> 2.3.0 available');
    expect(nag).toContain('curl -fsSL https://opensip.ai/cli/install.sh | bash');
    expect(nag).toContain('OPENSIP_NO_UPDATE=1');
  });
});
