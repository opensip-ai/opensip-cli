import { createHash } from 'node:crypto';

import {
  EPHEMERAL_MARKER_FILE,
  EPHEMERAL_MARKER_MAX_BYTES,
  EPHEMERAL_MARKER_VERSION,
  readAnchoredRecord,
} from '@opensip-cli/core';

import { runtimePromotionFilesystemFailure } from './runtime-promotion-filesystem-io.js';

import type { RuntimePromotionJournal } from './runtime-promotion-journal-schema.js';
import type { RuntimePromotionProjectRootAuthority } from './runtime-promotion-root-authority.js';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function markerRecord(
  runtimeDir: string,
  trustedAnchorDir: string,
): {
  readonly content: string;
  readonly sha256: string;
} {
  const observed = readAnchoredRecord({
    trustedAnchorDir,
    parentDir: runtimeDir,
    basename: EPHEMERAL_MARKER_FILE,
    maxBytes: EPHEMERAL_MARKER_MAX_BYTES,
    permissionPosture: 'owner-controlled',
    recordPosture: 'owner-controlled',
  });
  if (observed.status !== 'present') {
    runtimePromotionFilesystemFailure('the selected cache marker is not present');
  }
  return observed;
}

function parseMarker(content: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // The bounded failure below deliberately omits parser detail.
  }
  runtimePromotionFilesystemFailure('the selected cache marker is malformed');
}

function legacyMarkerAuthoritative(
  marker: Record<string, unknown>,
  cacheKey: string,
  authority: RuntimePromotionProjectRootAuthority,
): boolean {
  const legacyMarker = marker.version === undefined && cacheKey === authority.coordinationKey;
  const weakIdentity =
    (marker.identityStrength === 'generation-bound' &&
      typeof marker.generationDigest === 'string' &&
      /^[a-f0-9]{64}$/u.test(marker.generationDigest)) ||
    (marker.identityStrength === 'path-only' && marker.generationDigest === undefined);
  const weakCurrentMarker =
    marker.version === EPHEMERAL_MARKER_VERSION &&
    marker.canonicalRootDigest === sha256(authority.projectRoot) &&
    weakIdentity;
  return legacyMarker || weakCurrentMarker;
}

function currentMarkerAuthoritative(
  marker: Record<string, unknown>,
  journal: RuntimePromotionJournal,
  authority: RuntimePromotionProjectRootAuthority,
  cacheKey: string,
): boolean {
  const classification = journal.source.classification;
  const canonicalRootDigest = sha256(authority.projectRoot);
  const markerGeneration = marker.generationDigest;
  const expectedGeneration = journal.source.generationDigest;
  const generationMatches =
    classification === 'generation-bound'
      ? typeof markerGeneration === 'string' &&
        markerGeneration === expectedGeneration &&
        cacheKey ===
          sha256(`opensip-ephemeral-cache-v2\0${canonicalRootDigest}\0${markerGeneration}`).slice(
            0,
            24,
          )
      : classification === 'path-only' &&
        markerGeneration === undefined &&
        expectedGeneration === null &&
        cacheKey === authority.coordinationKey;
  return (
    marker.version === EPHEMERAL_MARKER_VERSION &&
    marker.canonicalRootDigest === canonicalRootDigest &&
    marker.identityStrength === classification &&
    generationMatches
  );
}

export function assertSourceMarkerAuthority(
  runtimeDir: string,
  trustedAnchorDir: string,
  journal: RuntimePromotionJournal,
  authority: RuntimePromotionProjectRootAuthority,
): void {
  const expectedHash = journal.source.markerSha256;
  const cacheKey = journal.source.cacheKey;
  if (expectedHash === null || cacheKey === null) {
    runtimePromotionFilesystemFailure('the selected cache marker lacks journal authority');
  }
  const observed = markerRecord(runtimeDir, trustedAnchorDir);
  if (observed.sha256 !== expectedHash) {
    runtimePromotionFilesystemFailure('the selected cache marker changed after journal creation');
  }
  const marker = parseMarker(observed.content);
  if (marker.projectDir !== authority.projectRoot) {
    runtimePromotionFilesystemFailure('the selected cache marker belongs to another project');
  }

  const classification = journal.source.classification;
  if (classification === 'legacy') {
    if (!legacyMarkerAuthoritative(marker, cacheKey, authority)) {
      runtimePromotionFilesystemFailure('the selected legacy cache marker is not authoritative');
    }
    return;
  }
  if (!currentMarkerAuthoritative(marker, journal, authority, cacheKey)) {
    runtimePromotionFilesystemFailure('the selected cache marker identity is not authoritative');
  }
}
