/**
 * Coverage for `checkForUpdate`: the "an update is available" and "the
 * notifier threw" branches (which the environment-dependent test in
 * update-notifier.test.ts can't force), plus the sticky-store behaviour that
 * makes the notice persist across runs and self-clear after an upgrade. We
 * mock the upstream `update-notifier` package so `notifier.update` is
 * deterministic, and inject an isolated state file per test.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readKnownLatest, writeKnownLatest } from '../update-state.js';

// Controlled by each test before calling checkForUpdate. `undefined` ⇒ the
// notifier reports no update; an object ⇒ that update; throwing is handled
// via mockImplementationOnce below.
let fakeUpdate: { latest: string; current: string } | undefined;

vi.mock('update-notifier', () => ({
  default: vi.fn(() => ({ update: fakeUpdate })),
}));

const savedTTY = process.stdout.isTTY;

// Per-test isolated sticky-state file so the display state can't leak across
// tests or touch the developer's real ~/.opensip-cli/update-state.json.
let tmpDir: string;
let stateFile: string;

beforeEach(() => {
  delete process.env.OPENSIP_NO_UPDATE;
  delete process.env.NO_UPDATE_NOTIFIER;
  fakeUpdate = undefined;
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
  tmpDir = mkdtempSync(join(tmpdir(), 'osip-upd-'));
  stateFile = join(tmpDir, 'update-state.json');
  vi.resetModules();
});

afterEach(() => {
  Object.defineProperty(process.stdout, 'isTTY', { value: savedTTY, configurable: true });
  vi.restoreAllMocks();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('checkForUpdate (mocked notifier)', () => {
  it('returns the latest version when npm reports a genuinely newer release', async () => {
    fakeUpdate = { latest: '9.9.9', current: '1.0.0' };
    const { checkForUpdate } = await import('../update-notifier.js');
    expect(checkForUpdate({ name: 'opensip-cli', version: '1.0.0', stateFile })).toBe('9.9.9');
  });

  it('mirrors a fresh newer release into the sticky store', async () => {
    fakeUpdate = { latest: '9.9.9', current: '1.0.0' };
    const { checkForUpdate } = await import('../update-notifier.js');
    checkForUpdate({ name: 'opensip-cli', version: '1.0.0', stateFile });
    expect(readKnownLatest(stateFile)).toBe('9.9.9');
  });

  it('keeps showing the update on later runs even after the notifier goes quiet', async () => {
    // Run 1: the daily check reports an update → mirrored to the store.
    fakeUpdate = { latest: '9.9.9', current: '1.0.0' };
    const { checkForUpdate } = await import('../update-notifier.js');
    expect(checkForUpdate({ name: 'opensip-cli', version: '1.0.0', stateFile })).toBe('9.9.9');

    // Run 2: update-notifier deleted its own cache, so it now reports nothing
    // — but the notice must persist from the sticky store. This is the whole
    // point of the change.
    fakeUpdate = undefined;
    expect(checkForUpdate({ name: 'opensip-cli', version: '1.0.0', stateFile })).toBe('9.9.9');
  });

  it('self-clears the sticky store once the running version catches up', async () => {
    // Store says 9.9.9 is available, but we are now running 9.9.9.
    writeKnownLatest('9.9.9', stateFile);
    fakeUpdate = undefined;
    const { checkForUpdate } = await import('../update-notifier.js');
    expect(checkForUpdate({ name: 'opensip-cli', version: '9.9.9', stateFile })).toBeUndefined();
    // The stale entry is wiped so the notice stops on its own after upgrade.
    expect(readKnownLatest(stateFile)).toBeUndefined();
    expect(existsSync(stateFile)).toBe(true); // cleared in place, not deleted
  });

  it('returns undefined when the reported latest is not newer', async () => {
    fakeUpdate = { latest: '1.0.0', current: '2.0.0' };
    const { checkForUpdate } = await import('../update-notifier.js');
    expect(checkForUpdate({ name: 'opensip-cli', version: '2.0.0', stateFile })).toBeUndefined();
  });

  it('degrades silently to undefined when the notifier throws', async () => {
    const updateNotifierMod = await import('update-notifier');
    const notifier = updateNotifierMod.default as unknown as ReturnType<typeof vi.fn>;
    notifier.mockImplementationOnce(() => {
      throw new Error('corrupt update cache');
    });
    const { checkForUpdate } = await import('../update-notifier.js');
    expect(checkForUpdate({ name: 'opensip-cli', version: '1.0.0', stateFile })).toBeUndefined();
    // A throwing fetch leaves no sticky residue.
    expect(readKnownLatest(stateFile)).toBeUndefined();
  });
});
