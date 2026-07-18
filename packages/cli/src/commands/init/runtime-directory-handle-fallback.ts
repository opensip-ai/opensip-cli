const WINDOWS_DIRECTORY_HANDLE_FALLBACK_CODES = new Set(['EINVAL', 'ENOTSUP', 'EPERM']);

/**
 * Windows may reject POSIX-style directory handles or directory fsync. Only
 * this narrow, explicit error set permits the identity-rechecking fallback.
 */
export function isWindowsDirectoryHandleFallback(
  error: unknown,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return (
    platform === 'win32' &&
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    WINDOWS_DIRECTORY_HANDLE_FALLBACK_CODES.has(error.code)
  );
}
