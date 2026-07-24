import { describe, expect, it } from 'vitest';

import {
  classifyAuthoredPathPosture,
  isCanonicalAuthoredPathMode,
  isSafeAuthoredPathMode,
  normalizeAuthoredPathMode,
} from '../authored-path-mode.js';
import { openInitAuthoredSnapshotPath } from '../init-authored-plan-snapshot.js';

function capabilityError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

describe('authored path platform posture', () => {
  it('normalizes synthesized Windows modes into the portable replay vocabulary', () => {
    expect(normalizeAuthoredPathMode(0o666, 'file', 'win32')).toBe(0o644);
    expect(normalizeAuthoredPathMode(0o444, 'file', 'win32')).toBe(0o444);
    expect(normalizeAuthoredPathMode(0o777, 'directory', 'win32')).toBe(0o755);
    expect(normalizeAuthoredPathMode(0o555, 'directory', 'win32')).toBe(0o555);
    expect(isCanonicalAuthoredPathMode(0o644, 'file', 'win32')).toBe(true);
    expect(isCanonicalAuthoredPathMode(0o755, 'directory', 'win32')).toBe(true);
  });

  it('retains strict POSIX unsafe-mode rejection', () => {
    expect(isSafeAuthoredPathMode(0o755, 'linux')).toBe(true);
    expect(isSafeAuthoredPathMode(0o777, 'linux')).toBe(false);
    expect(isCanonicalAuthoredPathMode(0o666, 'file', 'linux')).toBe(false);
  });

  it('accepts owner-verified group-writable modes (umask 002 / user-private-group layout)', () => {
    // Stock Debian/Ubuntu git clones are 0775/0664; every caller pairs this
    // predicate with a uid ownership check, so acceptance stays owner-scoped.
    expect(isSafeAuthoredPathMode(0o775, 'linux')).toBe(true);
    expect(isSafeAuthoredPathMode(0o664, 'linux')).toBe(true);
    expect(isCanonicalAuthoredPathMode(0o775, 'directory', 'linux')).toBe(true);
    expect(isCanonicalAuthoredPathMode(0o664, 'file', 'linux')).toBe(true);
    // Other-writable and special bits remain hard refusals.
    expect(isSafeAuthoredPathMode(0o776, 'linux')).toBe(false);
    expect(isSafeAuthoredPathMode(0o2775, 'linux')).toBe(false);
    expect(isSafeAuthoredPathMode(0o4755, 'linux')).toBe(false);
    expect(isSafeAuthoredPathMode(0o1777, 'linux')).toBe(false);
  });

  it('classifies the accepted posture for provenance', () => {
    expect(classifyAuthoredPathPosture(0o755, 'linux')).toBe('strict');
    expect(classifyAuthoredPathPosture(0o775, 'linux')).toBe('group-writable');
    expect(classifyAuthoredPathPosture(0o664, 'linux')).toBe('group-writable');
    // Windows synthesized modes never carry a meaningful group bit.
    expect(classifyAuthoredPathPosture(0o777, 'win32')).toBe('strict');
  });

  it.each(['EINVAL', 'ENOTSUP', 'EPERM'])(
    'uses the narrow Windows directory-handle fallback for %s',
    (code) => {
      expect(
        openInitAuthoredSnapshotPath('/unused', true, {
          platform: 'win32',
          open: () => {
            throw capabilityError(code);
          },
        }),
      ).toBeUndefined();
    },
  );

  it('does not broaden the fallback to files or non-Windows platforms', () => {
    const open = () => {
      throw capabilityError('EINVAL');
    };
    expect(() =>
      openInitAuthoredSnapshotPath('/unused', false, { platform: 'win32', open }),
    ).toThrow(/could not safely open/iu);
    expect(() =>
      openInitAuthoredSnapshotPath('/unused', true, { platform: 'linux', open }),
    ).toThrow(/could not safely open/iu);
  });
});
