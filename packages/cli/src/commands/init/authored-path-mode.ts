export type AuthoredPathType = 'file' | 'directory';

function permissionBits(mode: number | bigint): number {
  return typeof mode === 'bigint' ? Number(mode & 0o777n) : mode & 0o777;
}

/**
 * Normalize Node's synthesized Windows permission bits into the portable
 * authored-plan vocabulary. Windows preserves the read-only distinction but
 * cannot faithfully represent POSIX group/other permission differences.
 */
export function normalizeAuthoredPathMode(
  mode: number | bigint,
  type: AuthoredPathType,
  platform: NodeJS.Platform = process.platform,
): number {
  const bits = permissionBits(mode);
  if (platform !== 'win32') return bits;
  const writable = (bits & 0o222) !== 0;
  if (type === 'directory') return writable ? 0o755 : 0o555;
  return writable ? 0o644 : 0o444;
}

export function isSafeAuthoredPathMode(
  mode: number | bigint,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform === 'win32') return true;
  const bits = typeof mode === 'bigint' ? Number(mode & 0o7777n) : mode & 0o7777;
  return (bits & 0o7000) === 0 && (bits & 0o022) === 0;
}

export function isCanonicalAuthoredPathMode(
  mode: number,
  type: AuthoredPathType,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return (
    Number.isInteger(mode) &&
    mode >= 0 &&
    mode <= 0o777 &&
    mode === normalizeAuthoredPathMode(mode, type, platform) &&
    isSafeAuthoredPathMode(mode, platform)
  );
}
