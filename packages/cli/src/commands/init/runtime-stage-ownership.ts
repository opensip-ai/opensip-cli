import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';

import { RuntimeManifestError } from './runtime-manifest-model.js';
import {
  runtimePromotionOwnedBasename,
  runtimePromotionOwnershipId,
} from './runtime-promotion-owned-identities.js';

import type { RuntimeStageMaterializationIdentity } from './runtime-promotion-journal-controller-internal.js';
import type { BigIntStats } from 'node:fs';

export const RUNTIME_STAGE_OWNERSHIP_FILE = '.opensip-init-runtime-stage-owner.json';

const RUNTIME_STAGE_OWNERSHIP_KIND = 'opensip-init-runtime-stage-ownership';
const RUNTIME_STAGE_OWNERSHIP_VERSION = 1;
const RUNTIME_STAGE_OWNERSHIP_MODE = 0o600;

export type RuntimeStageOwnershipIdentity = RuntimeStageMaterializationIdentity;

export type RuntimeStageOwnershipCheckpoint =
  'after-marker-open' | 'after-marker-write' | 'after-marker-fsync';

export interface RuntimeStageOwnershipDependencies {
  readonly checkpoint?: (checkpoint: RuntimeStageOwnershipCheckpoint) => void;
  /** Reassert the held stage-root inode after every injected boundary. */
  readonly assertRootStable?: () => void;
}

interface MarkerIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly uid: bigint;
  readonly mode: bigint;
  readonly nlink: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

function fail(): never {
  throw new RuntimeManifestError('stage-ownership');
}

function markerIdentity(stat: BigIntStats): MarkerIdentity {
  return {
    dev: stat.dev,
    ino: stat.ino,
    uid: stat.uid,
    mode: stat.mode,
    nlink: stat.nlink,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
  };
}

function sameMarkerIdentity(left: MarkerIdentity, right: MarkerIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.uid === right.uid &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function assertOwnershipIdentity(identity: RuntimeStageOwnershipIdentity): void {
  try {
    if (
      runtimePromotionOwnedBasename(identity.operationId, 'runtimeStage') !==
        identity.stageBasename ||
      runtimePromotionOwnershipId(identity.operationId, 'runtimeStage') !== identity.ownershipId
    ) {
      fail();
    }
  } catch (error) {
    if (error instanceof RuntimeManifestError) throw error;
    fail();
  }
}

/** Canonical bounded bytes written as the first child of an owned runtime stage. */
export function encodeRuntimeStageOwnershipMarker(identity: RuntimeStageOwnershipIdentity): string {
  assertOwnershipIdentity(identity);
  return JSON.stringify({
    kind: RUNTIME_STAGE_OWNERSHIP_KIND,
    version: RUNTIME_STAGE_OWNERSHIP_VERSION,
    operationId: identity.operationId,
    slot: 'runtimeStage',
    ownershipId: identity.ownershipId,
    basename: identity.stageBasename,
  });
}

function assertMarkerStat(stat: BigIntStats, expectedBytes: number): void {
  const uid = typeof process.getuid === 'function' ? BigInt(process.getuid()) : undefined;
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1n ||
    stat.size !== BigInt(expectedBytes) ||
    (uid !== undefined && stat.uid !== uid) ||
    (process.platform !== 'win32' && Number(stat.mode & 0o7777n) !== RUNTIME_STAGE_OWNERSHIP_MODE)
  ) {
    fail();
  }
}

function writeAll(descriptor: number, content: Buffer): void {
  let offset = 0;
  while (offset < content.length) {
    const written = writeSync(descriptor, content, offset, content.length - offset);
    if (written < 1) fail();
    offset += written;
  }
}

/**
 * Create the exact operation marker. The caller owns directory and parent
 * fsyncs so it can establish the complete stage-ownership durability barrier.
 */
export function createRuntimeStageOwnershipMarker(
  stageDir: string,
  identity: RuntimeStageOwnershipIdentity,
  dependencies: RuntimeStageOwnershipDependencies = {},
): void {
  const content = Buffer.from(encodeRuntimeStageOwnershipMarker(identity), 'utf8');
  const markerPath = join(stageDir, RUNTIME_STAGE_OWNERSHIP_FILE);
  let descriptor: number | undefined;
  try {
    dependencies.assertRootStable?.();
    descriptor = openSync(
      markerPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      RUNTIME_STAGE_OWNERSHIP_MODE,
    );
    dependencies.checkpoint?.('after-marker-open');
    dependencies.assertRootStable?.();
    writeAll(descriptor, content);
    fchmodSync(descriptor, RUNTIME_STAGE_OWNERSHIP_MODE);
    dependencies.checkpoint?.('after-marker-write');
    dependencies.assertRootStable?.();
    fsyncSync(descriptor);
    dependencies.checkpoint?.('after-marker-fsync');
    dependencies.assertRootStable?.();
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  dependencies.assertRootStable?.();
  assertRuntimeStageOwnershipMarker(stageDir, identity);
  dependencies.assertRootStable?.();
}

/** Verify exact marker bytes and stable single-link file identity without following links. */
export function assertRuntimeStageOwnershipMarker(
  stageDir: string,
  identity: RuntimeStageOwnershipIdentity,
): void {
  const expected = Buffer.from(encodeRuntimeStageOwnershipMarker(identity), 'utf8');
  const markerPath = join(stageDir, RUNTIME_STAGE_OWNERSHIP_FILE);
  let descriptor: number | undefined;
  try {
    const before = lstatSync(markerPath, { bigint: true });
    assertMarkerStat(before, expected.length);
    descriptor = openSync(markerPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(descriptor, { bigint: true });
    assertMarkerStat(opened, expected.length);
    if (!sameMarkerIdentity(markerIdentity(before), markerIdentity(opened))) fail();

    const observed = Buffer.allocUnsafe(expected.length + 1);
    let offset = 0;
    while (offset < observed.length) {
      const bytesRead = readSync(descriptor, observed, offset, observed.length - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== expected.length || !observed.subarray(0, offset).equals(expected)) {
      fail();
    }

    const afterOpened = fstatSync(descriptor, { bigint: true });
    const afterPath = lstatSync(markerPath, { bigint: true });
    if (
      !sameMarkerIdentity(markerIdentity(opened), markerIdentity(afterOpened)) ||
      !sameMarkerIdentity(markerIdentity(afterOpened), markerIdentity(afterPath))
    ) {
      fail();
    }
  } catch (error) {
    if (error instanceof RuntimeManifestError) throw error;
    fail();
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
