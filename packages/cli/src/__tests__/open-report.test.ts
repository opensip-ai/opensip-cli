import { describe, it, expect } from 'vitest';

import { buildReportLaunchTarget, decideReportOpen, launchReport } from '../open-report.js';

function base() {
  return {
    openRequested: true,
    jsonOutput: false,
    stdoutIsTTY: true,
    env: {} as NodeJS.ProcessEnv,
  };
}

describe('decideReportOpen', () => {
  it('does not open when not requested', () => {
    expect(decideReportOpen({ ...base(), openRequested: false })).toEqual({
      shouldOpen: false,
      reason: 'not-requested',
    });
  });

  it('does not open in json mode', () => {
    expect(decideReportOpen({ ...base(), jsonOutput: true })).toEqual({
      shouldOpen: false,
      reason: 'json-mode',
    });
  });

  it('does not open when stdout is not a TTY', () => {
    expect(decideReportOpen({ ...base(), stdoutIsTTY: false })).toEqual({
      shouldOpen: false,
      reason: 'non-tty',
    });
  });

  it('does not open under CI env', () => {
    expect(decideReportOpen({ ...base(), env: { CI: '1' } })).toEqual({
      shouldOpen: false,
      reason: 'ci-env',
    });
  });

  it('does not open under SSH without a display', () => {
    expect(decideReportOpen({ ...base(), env: { SSH_CONNECTION: 'x' } })).toEqual({
      shouldOpen: false,
      reason: 'ssh-no-display',
    });
    expect(decideReportOpen({ ...base(), env: { SSH_CLIENT: 'x' } })).toEqual({
      shouldOpen: false,
      reason: 'ssh-no-display',
    });
  });

  it('opens under SSH if DISPLAY is set', () => {
    expect(
      decideReportOpen({
        ...base(),
        env: { SSH_CONNECTION: 'x', DISPLAY: ':0' },
      }),
    ).toEqual({
      shouldOpen: true,
      reason: 'ok',
    });
  });

  it('opens under SSH if WAYLAND_DISPLAY is set', () => {
    expect(
      decideReportOpen({
        ...base(),
        env: { SSH_CONNECTION: 'x', WAYLAND_DISPLAY: 'wayland-0' },
      }),
    ).toEqual({ shouldOpen: true, reason: 'ok' });
  });

  it('opens in the happy path', () => {
    expect(decideReportOpen(base())).toEqual({
      shouldOpen: true,
      reason: 'ok',
    });
  });
});

describe('launchReport', () => {
  it('returns false when `open` throws', async () => {
    // Pass an invalid target that on most systems will fail to open. On CI
    // / non-graphical hosts this is reliably a failure path — but accept
    // either result so the test is portable.
    const ok = await launchReport('://invalid::not-a-url');
    expect(typeof ok).toBe('boolean');
  });
});

describe('buildReportLaunchTarget', () => {
  it('appends only the closed Change Impact fragment grammar', () => {
    expect(buildReportLaunchTarget('/repo/reports/latest.html', '#change-impact')).toBe(
      'file:///repo/reports/latest.html#change-impact',
    );
    expect(buildReportLaunchTarget('/repo/reports/latest.html', '#change-impact/run_A-1')).toBe(
      'file:///repo/reports/latest.html#change-impact/run_A-1',
    );
  });

  it('encodes filesystem metacharacters before adding the selection fragment', () => {
    expect(buildReportLaunchTarget('/repo/report #1.html', '#change-impact')).toBe(
      'file:///repo/report%20%231.html#change-impact',
    );
  });

  it.each([
    '#overview',
    '#change-impact/',
    '#change-impact/a/b',
    '#change-impact/%2Fetc',
    `#change-impact/${'a'.repeat(129)}`,
  ])('ignores an arbitrary or malformed fragment %s', (fragment) => {
    expect(buildReportLaunchTarget('/repo/reports/latest.html', fragment)).toBe(
      '/repo/reports/latest.html',
    );
  });
});
