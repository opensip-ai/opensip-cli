import { lstatSync, opendirSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';

import {
  compareRuntimeManifests,
  encodeRuntimeStageOwnershipMarker,
  inspectVerifiedRuntimeManifest,
  isRuntimeManifestReleaseUnsafe,
  RUNTIME_MANIFEST_MAX_ENTRIES,
  RUNTIME_MANIFEST_MAX_PATH_AGGREGATE_BYTES,
  RUNTIME_MANIFEST_MAX_PATH_BYTES,
  RUNTIME_STAGE_OWNERSHIP_FILE,
  runtimeManifestIdentityEqual,
} from './runtime-manifest.js';
import {
  classifyRuntimePromotionPath,
  runtimePromotionFilesystemFailure,
} from './runtime-promotion-filesystem-io.js';
import { inspectExactPromotionMarker } from './runtime-promotion-filesystem-marker-io.js';

import type {
  RuntimeManifestEntry,
  RuntimeStageOwnershipIdentity,
  VerifiedRuntimeManifest,
} from './runtime-manifest.js';
import type { BigIntStats } from 'node:fs';

export type RuntimeStageFilesystemState =
  | { readonly status: 'absent' }
  | { readonly status: 'verified'; readonly manifest: VerifiedRuntimeManifest }
  | {
      readonly status: 'verified-unmarked';
      readonly manifest: VerifiedRuntimeManifest;
    }
  | { readonly status: 'incomplete-owned' };

interface PartialStageBudget {
  entries: number;
  pathBytes: number;
}

function currentUid(): bigint | undefined {
  return typeof process.getuid === 'function' ? BigInt(process.getuid()) : undefined;
}

function assertCurrentOwner(stat: BigIntStats): void {
  const uid = currentUid();
  if (uid !== undefined && stat.uid !== uid) {
    runtimePromotionFilesystemFailure('an incomplete runtime stage has an unsafe owner');
  }
}

function safeMode(stat: BigIntStats): number {
  assertCurrentOwner(stat);
  const mode = Number(stat.mode & 0o7777n);
  if (process.platform !== 'win32' && ((mode & 0o7000) !== 0 || (mode & 0o022) !== 0)) {
    runtimePromotionFilesystemFailure('an incomplete runtime stage has an unsafe mode');
  }
  return mode & 0o777;
}

function entryMap(expected: VerifiedRuntimeManifest): ReadonlyMap<string, RuntimeManifestEntry> {
  return new Map(expected.entries.map((entry) => [entry.path, entry]));
}

function chargePath(path: string, budget: PartialStageBudget): void {
  const bytes = Buffer.byteLength(path, 'utf8');
  budget.entries += 1;
  budget.pathBytes += bytes;
  if (
    bytes < 1 ||
    bytes > RUNTIME_MANIFEST_MAX_PATH_BYTES ||
    budget.entries > RUNTIME_MANIFEST_MAX_ENTRIES ||
    budget.pathBytes > RUNTIME_MANIFEST_MAX_PATH_AGGREGATE_BYTES
  ) {
    runtimePromotionFilesystemFailure('incomplete runtime-stage inspection exceeded its bounds');
  }
}

function safeName(name: string): void {
  if (
    name.length === 0 ||
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    name.includes('\\') ||
    name.includes('\0')
  ) {
    runtimePromotionFilesystemFailure('an incomplete runtime stage has an unsafe entry name');
  }
}

function directoryNames(path: string): readonly string[] {
  const names: string[] = [];
  const directory = opendirSync(path);
  try {
    for (;;) {
      const entry = directory.readSync();
      if (entry === null) break;
      safeName(entry.name);
      names.push(entry.name);
      if (names.length > RUNTIME_MANIFEST_MAX_ENTRIES + 1) {
        runtimePromotionFilesystemFailure('an incomplete runtime stage exceeds its entry bound');
      }
    }
  } finally {
    directory.closeSync();
  }
  return names;
}

function assertExpectedPartialEntry(
  path: string,
  expected: RuntimeManifestEntry,
  stat: BigIntStats,
): void {
  if (expected.kind === 'symlink') {
    assertCurrentOwner(stat);
    if (!stat.isSymbolicLink() || readlinkSync(path) !== expected.target) {
      runtimePromotionFilesystemFailure('an incomplete stage symlink does not match its manifest');
    }
    return;
  }
  const mode = safeMode(stat);
  if (expected.kind === 'directory') {
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (mode !== 0o700 && mode !== expected.mode)
    ) {
      runtimePromotionFilesystemFailure('an incomplete stage directory is not operation-owned');
    }
    return;
  }
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1n ||
    stat.size > BigInt(expected.sizeBytes) ||
    (mode !== 0o600 && mode !== expected.mode)
  ) {
    runtimePromotionFilesystemFailure('an incomplete stage file is not operation-owned');
  }
  // An exact-marker stage is operation-owned. Wrong or partial bytes are a
  // recoverable interrupted copy and may be removed; they are never accepted
  // as verified stage authority.
}

function inspectPartialDirectory(
  root: string,
  relativeDirectory: string,
  expectedEntries: ReadonlyMap<string, RuntimeManifestEntry>,
  budget: PartialStageBudget,
): void {
  const directoryPath =
    relativeDirectory.length === 0 ? root : join(root, ...relativeDirectory.split('/'));
  for (const name of directoryNames(directoryPath)) {
    if (relativeDirectory.length === 0 && name === RUNTIME_STAGE_OWNERSHIP_FILE) continue;
    const relativePath = relativeDirectory.length === 0 ? name : `${relativeDirectory}/${name}`;
    chargePath(relativePath, budget);
    const expected = expectedEntries.get(relativePath);
    if (expected === undefined) {
      runtimePromotionFilesystemFailure('an incomplete runtime stage contains an unowned entry');
    }
    const path = join(directoryPath, name);
    const stat = lstatSync(path, { bigint: true });
    assertExpectedPartialEntry(path, expected, stat);
    if (expected.kind === 'directory') {
      inspectPartialDirectory(root, relativePath, expectedEntries, budget);
    }
  }
}

function assertRecoverableIncompleteStage(
  stageDir: string,
  expected: VerifiedRuntimeManifest,
): void {
  const root = lstatSync(stageDir, { bigint: true });
  const mode = safeMode(root);
  if (
    !root.isDirectory() ||
    root.isSymbolicLink() ||
    (mode !== 0o700 && mode !== expected.identity.rootMode)
  ) {
    runtimePromotionFilesystemFailure('an incomplete runtime-stage root is unsafe');
  }
  inspectPartialDirectory(stageDir, '', entryMap(expected), {
    entries: 0,
    pathBytes: 0,
  });
}

function inspectCompleteMarkedStage(
  stageDir: string,
  ownership: RuntimeStageOwnershipIdentity,
  expected: VerifiedRuntimeManifest,
): VerifiedRuntimeManifest | undefined {
  try {
    const observed = inspectVerifiedRuntimeManifest(stageDir, 'promotion-stage', {}, ownership);
    return compareRuntimeManifests(expected, observed).equal ? observed : undefined;
  } catch (error) {
    if (isRuntimeManifestReleaseUnsafe(error)) throw error;
    return undefined;
  }
}

function inspectCompleteUnmarkedStage(
  stageDir: string,
  expected: VerifiedRuntimeManifest,
): VerifiedRuntimeManifest {
  const observed = inspectVerifiedRuntimeManifest(stageDir, 'project-runtime');
  if (
    !runtimeManifestIdentityEqual(expected.identity, observed.identity) ||
    !compareRuntimeManifests(expected, observed).equal
  ) {
    runtimePromotionFilesystemFailure('an unmarked runtime stage does not match its journal');
  }
  return observed;
}

/** Inspect a stage without ever following its root or entries. */
export function inspectRuntimeStageFilesystemState(
  stageDir: string,
  ownership: RuntimeStageOwnershipIdentity,
  expected: VerifiedRuntimeManifest,
  allowInstallWindow: boolean,
): RuntimeStageFilesystemState {
  const root = classifyRuntimePromotionPath(stageDir);
  if (root.status === 'absent') return { status: 'absent' };
  if (root.status !== 'directory' || root.owner !== 'current') {
    runtimePromotionFilesystemFailure('the runtime stage root has an unsafe type or owner');
  }
  const markerContent = encodeRuntimeStageOwnershipMarker(ownership);
  const markerPath = join(stageDir, RUNTIME_STAGE_OWNERSHIP_FILE);
  const marker = inspectExactPromotionMarker(markerPath, markerContent);
  if (marker.status === 'mismatch') {
    runtimePromotionFilesystemFailure('the runtime stage belongs to another operation');
  }
  if (marker.status === 'exact') {
    const complete = inspectCompleteMarkedStage(stageDir, ownership, expected);
    if (complete !== undefined) return { status: 'verified', manifest: complete };
    assertRecoverableIncompleteStage(stageDir, expected);
    return { status: 'incomplete-owned' };
  }
  if (marker.status === 'partial-prefix') {
    const names = directoryNames(stageDir);
    if (names.length !== 1 || names[0] !== RUNTIME_STAGE_OWNERSHIP_FILE) {
      runtimePromotionFilesystemFailure('a partial stage marker accompanies unexpected entries');
    }
    return { status: 'incomplete-owned' };
  }
  if (allowInstallWindow) {
    return {
      status: 'verified-unmarked',
      manifest: inspectCompleteUnmarkedStage(stageDir, expected),
    };
  }
  if (directoryNames(stageDir).length > 0) {
    runtimePromotionFilesystemFailure('an unmarked incomplete stage is not empty');
  }
  return { status: 'incomplete-owned' };
}

export function stageMarkerPath(stageDir: string): string {
  return join(stageDir, RUNTIME_STAGE_OWNERSHIP_FILE);
}
