import { lstatSync, type BigIntStats } from 'node:fs';

export type RuntimePromotionPathPresence = 'absent' | 'directory' | 'unsafe';

export interface RuntimePromotionPathIdentity {
  readonly dev: string;
  readonly ino: string;
  readonly uid: string;
  readonly mode: string;
  readonly nlink: string;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
}

export interface RuntimePromotionPathSnapshot {
  readonly presence: RuntimePromotionPathPresence;
  readonly identity?: RuntimePromotionPathIdentity;
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function identity(stat: BigIntStats): RuntimePromotionPathIdentity {
  return {
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    uid: stat.uid.toString(),
    mode: stat.mode.toString(),
    nlink: stat.nlink.toString(),
    mtimeNs: stat.mtimeNs.toString(),
    ctimeNs: stat.ctimeNs.toString(),
  };
}

function sameIdentity(
  left: RuntimePromotionPathIdentity | undefined,
  right: RuntimePromotionPathIdentity | undefined,
): boolean {
  if (left === undefined || right === undefined) return false;
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.uid === right.uid &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

export function runtimePromotionPathSnapshot(path: string): RuntimePromotionPathSnapshot {
  try {
    const stat = lstatSync(path, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.nlink < 1n) {
      return { presence: 'unsafe' };
    }
    return { presence: 'directory', identity: identity(stat) };
  } catch (error) {
    return hasCode(error, 'ENOENT') ? { presence: 'absent' } : { presence: 'unsafe' };
  }
}

export function sameRuntimePromotionPathSnapshot(
  left: RuntimePromotionPathSnapshot,
  right: RuntimePromotionPathSnapshot,
): boolean {
  if (left.presence !== right.presence) return false;
  if (left.presence !== 'directory') return true;
  return sameIdentity(left.identity, right.identity);
}
