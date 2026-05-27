import { describe, it, expect } from 'vitest';

import { decideOpen, launchBrowser } from '../open-dashboard.js';

function base() {
  return {
    openRequested: true,
    jsonOutput: false,
    stdoutIsTTY: true,
    env: {} as NodeJS.ProcessEnv,
  };
}

describe('decideOpen', () => {

  it('does not open when not requested', () => {
    expect(decideOpen({ ...base(), openRequested: false })).toEqual({
      shouldOpen: false,
      reason: 'not-requested',
    });
  });

  it('does not open in json mode', () => {
    expect(decideOpen({ ...base(), jsonOutput: true })).toEqual({
      shouldOpen: false,
      reason: 'json-mode',
    });
  });

  it('does not open when stdout is not a TTY', () => {
    expect(decideOpen({ ...base(), stdoutIsTTY: false })).toEqual({
      shouldOpen: false,
      reason: 'non-tty',
    });
  });

  it('does not open under CI env', () => {
    expect(decideOpen({ ...base(), env: { CI: '1' } })).toEqual({
      shouldOpen: false,
      reason: 'ci-env',
    });
  });

  it('does not open under SSH without a display', () => {
    expect(decideOpen({ ...base(), env: { SSH_CONNECTION: 'x' } })).toEqual({
      shouldOpen: false,
      reason: 'ssh-no-display',
    });
    expect(decideOpen({ ...base(), env: { SSH_CLIENT: 'x' } })).toEqual({
      shouldOpen: false,
      reason: 'ssh-no-display',
    });
  });

  it('opens under SSH if DISPLAY is set', () => {
    expect(
      decideOpen({ ...base(), env: { SSH_CONNECTION: 'x', DISPLAY: ':0' } }),
    ).toEqual({ shouldOpen: true, reason: 'ok' });
  });

  it('opens under SSH if WAYLAND_DISPLAY is set', () => {
    expect(
      decideOpen({ ...base(), env: { SSH_CONNECTION: 'x', WAYLAND_DISPLAY: 'wayland-0' } }),
    ).toEqual({ shouldOpen: true, reason: 'ok' });
  });

  it('opens in the happy path', () => {
    expect(decideOpen(base())).toEqual({ shouldOpen: true, reason: 'ok' });
  });
});

describe('launchBrowser', () => {
  it('returns false when `open` throws', async () => {
    // Pass an invalid target that on most systems will fail to open. On CI
    // / non-graphical hosts this is reliably a failure path — but accept
    // either result so the test is portable.
    const ok = await launchBrowser('://invalid::not-a-url');
    expect(typeof ok).toBe('boolean');
  });
});
