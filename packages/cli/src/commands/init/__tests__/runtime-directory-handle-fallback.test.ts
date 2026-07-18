import { describe, expect, it } from 'vitest';

import { isWindowsDirectoryHandleFallback } from '../runtime-directory-handle-fallback.js';

describe('Windows directory-handle fallback', () => {
  it.each(['EINVAL', 'ENOTSUP', 'EPERM'] as const)(
    'accepts only the guarded Windows %s error',
    (code) => {
      expect(isWindowsDirectoryHandleFallback({ code }, 'win32')).toBe(true);
    },
  );

  it.each([
    { error: { code: 'EACCES' }, platform: 'win32' as const },
    { error: { code: 'EINVAL' }, platform: 'linux' as const },
    { error: new Error('missing code'), platform: 'win32' as const },
    { error: null, platform: 'win32' as const },
  ])('rejects a non-fallback posture: %#', ({ error, platform }) => {
    expect(isWindowsDirectoryHandleFallback(error, platform)).toBe(false);
  });
});
