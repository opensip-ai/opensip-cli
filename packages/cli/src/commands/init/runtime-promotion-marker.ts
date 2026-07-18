/**
 * Exact, read-only cache-marker classifier shared by Init preflight and status.
 *
 * Core's general cache reader is intentionally tolerant for ordinary no-Init
 * operation. Adoption authority is stricter: the marker must have the exact
 * versioned/legacy shape and pass the same anchored owner-controlled read used
 * by transactional Init.
 */

import {
  EPHEMERAL_MARKER_FILE,
  EPHEMERAL_MARKER_MAX_BYTES,
  EPHEMERAL_MARKER_VERSION,
  readAnchoredRecord,
  resolveUserPaths,
  type EphemeralMarker,
  type EphemeralProjectPaths,
  type LegacyEphemeralMarker,
} from '@opensip-cli/core';

export type RuntimePromotionParsedMarker =
  | { readonly kind: 'current'; readonly marker: EphemeralMarker }
  | { readonly kind: 'legacy'; readonly marker: LegacyEphemeralMarker };

export interface RuntimePromotionMarkerRecord {
  readonly marker: RuntimePromotionParsedMarker;
  readonly sha256: string;
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return !Number.isNaN(parsed) && new Date(parsed).toISOString() === value;
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  return (
    actual.length === canonical.length && actual.every((key, index) => key === canonical[index])
  );
}

/** Parse only the exact marker shapes that Init may nominate as authority. */
export function parseRuntimePromotionMarker(raw: string): RuntimePromotionParsedMarker | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return;
  const record = parsed as Record<string, unknown>;
  if (record.version === EPHEMERAL_MARKER_VERSION) {
    const identityStrength = record.identityStrength;
    const generationBound = identityStrength === 'generation-bound';
    const expectedKeys = generationBound
      ? [
          'version',
          'projectDir',
          'canonicalRootDigest',
          'identityStrength',
          'generationDigest',
          'lastUsedAt',
        ]
      : ['version', 'projectDir', 'canonicalRootDigest', 'identityStrength', 'lastUsedAt'];
    if (
      !exactKeys(record, expectedKeys) ||
      typeof record.projectDir !== 'string' ||
      !isDigest(record.canonicalRootDigest) ||
      (identityStrength !== 'generation-bound' && identityStrength !== 'path-only') ||
      (generationBound
        ? !isDigest(record.generationDigest)
        : record.generationDigest !== undefined) ||
      !isCanonicalTimestamp(record.lastUsedAt)
    ) {
      return;
    }
    return {
      kind: 'current',
      marker: {
        version: EPHEMERAL_MARKER_VERSION,
        projectDir: record.projectDir,
        canonicalRootDigest: record.canonicalRootDigest,
        identityStrength,
        ...(generationBound ? { generationDigest: record.generationDigest as string } : {}),
        lastUsedAt: record.lastUsedAt,
      },
    };
  }
  if (
    exactKeys(record, ['projectDir', 'lastUsedAt']) &&
    typeof record.projectDir === 'string' &&
    isCanonicalTimestamp(record.lastUsedAt)
  ) {
    return {
      kind: 'legacy',
      marker: {
        projectDir: record.projectDir,
        lastUsedAt: record.lastUsedAt,
      },
    };
  }
}

/** True only for the active marker bound to the current cache generation. */
export function currentRuntimePromotionMarkerMatches(
  marker: EphemeralMarker,
  paths: EphemeralProjectPaths,
): boolean {
  return (
    marker.projectDir === paths.projectDir &&
    marker.canonicalRootDigest === paths.canonicalRootDigest &&
    marker.identityStrength === paths.identityStrength &&
    marker.generationDigest === paths.generationDigest
  );
}

/**
 * Read and classify one candidate through Init's exact anchored trust posture.
 * Invalid, missing, unsafe, or concurrently replaced records are all
 * non-selectable; callers expose only that bounded fact.
 */
export function readRuntimePromotionMarkerRecord(
  runtimeDir: string,
): RuntimePromotionMarkerRecord | undefined {
  try {
    const observed = readAnchoredRecord({
      trustedAnchorDir: resolveUserPaths().ephemeralProjectsDir,
      parentDir: runtimeDir,
      basename: EPHEMERAL_MARKER_FILE,
      maxBytes: EPHEMERAL_MARKER_MAX_BYTES,
      permissionPosture: 'owner-controlled',
      recordPosture: 'owner-controlled',
    });
    if (observed.status !== 'present') return;
    const marker = parseRuntimePromotionMarker(observed.content);
    return marker === undefined ? undefined : { marker, sha256: observed.sha256 };
  } catch {
    return;
  }
}
