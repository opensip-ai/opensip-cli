import { journalError } from './runtime-promotion-journal-error.js';
import {
  RUNTIME_PROMOTION_JOURNAL_CAPS,
  assertRuntimeManifestIdentity,
  isSafeRuntimePromotionBasename,
  runtimePromotionOwnedBasename,
  runtimePromotionOwnershipId,
} from './runtime-promotion-journal-schema.js';

import type { RuntimePromotionArtifactMarker } from './runtime-promotion-filesystem-types.js';
import type {
  RuntimeManifestIdentity,
  RuntimePromotionOwnedSlotName,
} from './runtime-promotion-journal-schema.js';

export const RUNTIME_PROMOTION_ARTIFACT_MARKER_MAX_BYTES = 2048;
export const RUNTIME_PROMOTION_ARTIFACT_MARKER_MODE = 0o600;

const MARKER_SLOTS = [
  'destinationParent',
  'runtimeStage',
  'destinationBackup',
  'sourceTombstone',
] as const;
type MarkerSlot = (typeof MARKER_SLOTS)[number];

/** @throws {SystemError} Always; constructs the canonical artifact-marker validation failure. */
function markerFailure(message: string): never {
  throw journalError(
    `Invalid runtime promotion artifact marker: ${message}`,
    undefined,
    'journal-digest-mismatch',
  );
}

function canonicalManifest(
  identity: RuntimeManifestIdentity | null,
): RuntimeManifestIdentity | null {
  if (identity === null) return null;
  assertRuntimeManifestIdentity(identity, 'artifact marker manifest');
  return {
    digest: identity.digest,
    fileCount: identity.fileCount,
    directoryCount: identity.directoryCount,
    symlinkCount: identity.symlinkCount,
    rootMode: identity.rootMode,
    totalBytes: identity.totalBytes,
    sqlite:
      identity.sqlite.status === 'absent'
        ? { status: 'absent' }
        : {
            status: 'verified',
            sha256: identity.sqlite.sha256,
            userVersion: identity.sqlite.userVersion,
          },
  };
}

function assertMarkerSlot(slot: string): asserts slot is MarkerSlot {
  if (!(MARKER_SLOTS as readonly string[]).includes(slot)) {
    markerFailure('slot is unsupported');
  }
}

function canonicalRootIdentity(value: unknown): RuntimePromotionArtifactMarker['rootIdentity'] {
  if (value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    markerFailure('root identity has the wrong shape');
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== 2 ||
    keys[0] !== 'device' ||
    keys[1] !== 'inode' ||
    typeof record.device !== 'string' ||
    typeof record.inode !== 'string' ||
    !/^\d{1,40}$/u.test(record.device) ||
    !/^\d{1,40}$/u.test(record.inode)
  ) {
    markerFailure('root identity is invalid or noncanonical');
  }
  return { device: record.device, inode: record.inode };
}

function assertMarkerIdentity(marker: RuntimePromotionArtifactMarker): void {
  assertMarkerSlot(marker.slot);
  if (
    runtimePromotionOwnershipId(marker.operationId, marker.slot) !== marker.ownershipId ||
    marker.ownershipId.length > RUNTIME_PROMOTION_JOURNAL_CAPS.maxOwnershipIdBytes
  ) {
    markerFailure('ownership identity does not match the operation');
  }
  if (runtimePromotionOwnedBasename(marker.operationId, marker.slot) !== marker.artifactBasename) {
    markerFailure('artifact basename does not match the operation');
  }
  if (!isSafeRuntimePromotionBasename(marker.artifactBasename)) {
    markerFailure('artifact basename is unsafe');
  }
  if (
    (marker.slot === 'destinationParent' && marker.manifest !== null) ||
    (marker.slot !== 'destinationParent' && marker.manifest === null)
  ) {
    markerFailure('manifest binding does not match the slot');
  }
  // Every artifact marker is an authority over one exact directory object.
  // Manifest equality alone is not ownership: an attacker can replace a tree
  // with byte-identical contents. Keep the inode binding for owner, cleanup,
  // and rollback markers alike.
  const rootIdentity = canonicalRootIdentity(marker.rootIdentity);
  if (rootIdentity === null) {
    markerFailure('root identity does not match the marker purpose');
  }
  canonicalManifest(marker.manifest);
}

export function encodeRuntimePromotionArtifactMarker(
  marker: RuntimePromotionArtifactMarker,
): string {
  assertMarkerIdentity(marker);
  const encoded = JSON.stringify({
    kind: 'opensip-init-runtime-artifact',
    version: 1,
    operationId: marker.operationId,
    slot: marker.slot,
    ownershipId: marker.ownershipId,
    artifactBasename: marker.artifactBasename,
    purpose: marker.purpose,
    rootIdentity: canonicalRootIdentity(marker.rootIdentity),
    manifest: canonicalManifest(marker.manifest),
  });
  if (Buffer.byteLength(encoded, 'utf8') > RUNTIME_PROMOTION_ARTIFACT_MARKER_MAX_BYTES) {
    markerFailure('encoded bytes exceed the cap');
  }
  return encoded;
}

export function parseRuntimePromotionArtifactMarker(
  content: string,
): RuntimePromotionArtifactMarker {
  if (Buffer.byteLength(content, 'utf8') > RUNTIME_PROMOTION_ARTIFACT_MARKER_MAX_BYTES) {
    markerFailure('encoded bytes exceed the cap');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    markerFailure('content is not JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    markerFailure('content has the wrong shape');
  }
  const value = parsed as Record<string, unknown>;
  const expectedKeys = [
    'kind',
    'version',
    'operationId',
    'slot',
    'ownershipId',
    'artifactBasename',
    'purpose',
    'rootIdentity',
    'manifest',
  ];
  const keys = Object.keys(value);
  if (
    keys.length !== expectedKeys.length ||
    expectedKeys.some((key, index) => keys[index] !== key) ||
    value.kind !== 'opensip-init-runtime-artifact' ||
    value.version !== 1 ||
    typeof value.operationId !== 'string' ||
    typeof value.slot !== 'string' ||
    typeof value.ownershipId !== 'string' ||
    typeof value.artifactBasename !== 'string' ||
    !['owner', 'cleanup', 'rollback'].includes(String(value.purpose))
  ) {
    markerFailure('content fields are invalid or noncanonical');
  }
  assertMarkerSlot(value.slot);
  const marker: RuntimePromotionArtifactMarker = {
    kind: 'opensip-init-runtime-artifact',
    version: 1,
    operationId: value.operationId,
    slot: value.slot,
    ownershipId: value.ownershipId,
    artifactBasename: value.artifactBasename,
    purpose: value.purpose as RuntimePromotionArtifactMarker['purpose'],
    rootIdentity: canonicalRootIdentity(value.rootIdentity),
    manifest: value.manifest as RuntimeManifestIdentity | null,
  };
  if (encodeRuntimePromotionArtifactMarker(marker) !== content) {
    markerFailure('content is noncanonical');
  }
  return marker;
}

function derivedMarkerBasename(artifactBasename: string, suffix: string): string {
  if (
    !isSafeRuntimePromotionBasename(artifactBasename) ||
    !isSafeRuntimePromotionBasename(`${artifactBasename}${suffix}`)
  ) {
    markerFailure('derived marker basename is unsafe');
  }
  return `${artifactBasename}${suffix}`;
}

export function runtimePromotionOwnerMarkerBasename(artifactBasename: string): string {
  return derivedMarkerBasename(artifactBasename, '.owner.json');
}

export function runtimePromotionCleanupMarkerBasename(artifactBasename: string): string {
  return derivedMarkerBasename(artifactBasename, '.cleanup.json');
}

export function runtimePromotionRollbackMarkerBasename(stageBasename: string): string {
  return derivedMarkerBasename(stageBasename, '.rollback.json');
}

export function markerForOwnedSlot(
  operationId: string,
  slot: MarkerSlot,
  purpose: RuntimePromotionArtifactMarker['purpose'],
  manifest: RuntimeManifestIdentity | null,
  rootIdentity: RuntimePromotionArtifactMarker['rootIdentity'] = null,
): RuntimePromotionArtifactMarker {
  return {
    kind: 'opensip-init-runtime-artifact',
    version: 1,
    operationId,
    slot,
    ownershipId: runtimePromotionOwnershipId(operationId, slot),
    artifactBasename: runtimePromotionOwnedBasename(operationId, slot),
    purpose,
    rootIdentity,
    manifest,
  };
}

export function isRuntimeFilesystemSlot(slot: RuntimePromotionOwnedSlotName): slot is MarkerSlot {
  return (MARKER_SLOTS as readonly RuntimePromotionOwnedSlotName[]).includes(slot);
}
