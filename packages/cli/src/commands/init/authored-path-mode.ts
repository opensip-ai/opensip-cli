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

/**
 * Scoped `group-controlled` posture: reject setuid/setgid/sticky and
 * OTHER-writable bits, but ACCEPT group-writable. Every caller pairs this
 * with a `safeOwner` uid check, so a group-writable path is only ever
 * accepted when the current user owns it — which covers the stock
 * Debian/Ubuntu user-private-group layout (umask 002 → 0775 clone dirs, a
 * group effectively private to the owner) without admitting world-writable
 * paths or paths owned by someone else. The group-write bit stays in the
 * recorded snapshot mode, so provenance remains honest.
 */
export function isSafeAuthoredPathMode(
  mode: number | bigint,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform === 'win32') return true;
  const bits = typeof mode === 'bigint' ? Number(mode & 0o7777n) : mode & 0o7777;
  return (bits & 0o7000) === 0 && (bits & 0o002) === 0;
}

/**
 * Provenance label for an accepted authored-path mode: `'group-writable'`
 * when the (owner-verified) path carries the group-write bit, `'strict'`
 * otherwise. Used for the one-line init diagnostic and downstream trust
 * decisions; never a rejection signal on its own.
 */
export function classifyAuthoredPathPosture(
  mode: number | bigint,
  platform: NodeJS.Platform = process.platform,
): 'strict' | 'group-writable' {
  if (platform === 'win32') return 'strict';
  const bits = typeof mode === 'bigint' ? Number(mode & 0o7777n) : mode & 0o7777;
  return (bits & 0o020) === 0 ? 'strict' : 'group-writable';
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
