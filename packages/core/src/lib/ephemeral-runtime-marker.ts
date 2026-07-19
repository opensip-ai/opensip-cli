/**
 * Bounded codec and reader for no-init ephemeral runtime markers.
 *
 * Marker bytes are cache-owned and therefore untrusted. Reads stay descriptor
 * anchored to a fixed cap and return classifications instead of throwing.
 */

import { closeSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import type { EphemeralProjectIdentityStrength } from './paths.js';

/** Marker file recording which project an ephemeral cache entry belongs to. */
export const EPHEMERAL_MARKER_FILE = 'project.json';
/** Current marker schema written beside an ephemeral runtime. */
export const EPHEMERAL_MARKER_VERSION = 2;
/** Hard read cap for the untrusted cache-owned marker. */
export const EPHEMERAL_MARKER_MAX_BYTES = 4096;

/** Current generation-aware marker stored beside an ephemeral runtime. */
export interface EphemeralMarker {
  readonly version: typeof EPHEMERAL_MARKER_VERSION;
  /** Absolute project directory this runtime backs. */
  readonly projectDir: string;
  /** Digest of the canonical project root. Internal only. */
  readonly canonicalRootDigest: string;
  /** Strength of the cache storage identity. */
  readonly identityStrength: EphemeralProjectIdentityStrength;
  /** Digest of reliable root/gitdir facts, present only when generation-bound. */
  readonly generationDigest?: string;
  /** ISO timestamp of the most recent run against it. */
  readonly lastUsedAt: string;
}

/** Marker shape written before versioned generation-aware cache identities. */
export interface LegacyEphemeralMarker {
  readonly projectDir: string;
  readonly lastUsedAt: string;
}

/** Fail-closed reason for an invalid cache marker. */
export type EphemeralMarkerInvalidReason = 'oversize' | 'malformed' | 'unreadable';

/** Bounded, non-throwing result of inspecting one cache marker. */
export type EphemeralMarkerReadResult =
  | { readonly status: 'current'; readonly marker: EphemeralMarker }
  | { readonly status: 'legacy'; readonly marker: LegacyEphemeralMarker }
  | { readonly status: 'missing' }
  | {
      readonly status: 'invalid';
      readonly reason: EphemeralMarkerInvalidReason;
    };

/** Return whether a value is one canonical ISO timestamp. */
export function isValidEphemeralTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return !Number.isNaN(parsed) && new Date(parsed).toISOString() === value;
}

function validDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

function validIdentityStrength(value: unknown): value is EphemeralProjectIdentityStrength {
  return value === 'generation-bound' || value === 'path-only';
}

/** Parse marker bytes into a bounded current, legacy, or invalid projection. */
export function parseEphemeralMarker(raw: string): EphemeralMarkerReadResult {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed.version === EPHEMERAL_MARKER_VERSION) {
      const identityStrength = parsed.identityStrength;
      const generationDigest = parsed.generationDigest;
      const validGeneration =
        validIdentityStrength(identityStrength) &&
        (identityStrength === 'generation-bound'
          ? validDigest(generationDigest)
          : generationDigest === undefined);
      if (
        typeof parsed.projectDir !== 'string' ||
        parsed.projectDir.length === 0 ||
        !isAbsolute(parsed.projectDir) ||
        !isValidEphemeralTimestamp(parsed.lastUsedAt) ||
        !validDigest(parsed.canonicalRootDigest) ||
        !validGeneration
      ) {
        return { status: 'invalid', reason: 'malformed' };
      }
      return {
        status: 'current',
        marker: {
          version: EPHEMERAL_MARKER_VERSION,
          projectDir: parsed.projectDir,
          canonicalRootDigest: parsed.canonicalRootDigest,
          identityStrength,
          ...(identityStrength === 'generation-bound'
            ? { generationDigest: generationDigest as string }
            : {}),
          lastUsedAt: parsed.lastUsedAt,
        },
      };
    }

    if (
      parsed.version === undefined &&
      typeof parsed.projectDir === 'string' &&
      parsed.projectDir.length > 0 &&
      isAbsolute(parsed.projectDir) &&
      isValidEphemeralTimestamp(parsed.lastUsedAt)
    ) {
      return {
        status: 'legacy',
        marker: {
          projectDir: parsed.projectDir,
          lastUsedAt: parsed.lastUsedAt,
        },
      };
    }
    return { status: 'invalid', reason: 'malformed' };
  } catch {
    return { status: 'invalid', reason: 'malformed' };
  }
}

function isMissingFsError(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

function markerReadPreflight(
  entryDir: string,
  markerPath: string,
): EphemeralMarkerReadResult | undefined {
  try {
    const runtimeStat = lstatSync(entryDir);
    if (!runtimeStat.isDirectory()) return { status: 'invalid', reason: 'unreadable' };
  } catch (error) {
    return isMissingFsError(error)
      ? { status: 'missing' }
      : { status: 'invalid', reason: 'unreadable' };
  }

  try {
    const markerStat = lstatSync(markerPath);
    if (!markerStat.isFile()) return { status: 'invalid', reason: 'unreadable' };
    if (markerStat.size > EPHEMERAL_MARKER_MAX_BYTES) {
      return { status: 'invalid', reason: 'oversize' };
    }
  } catch (error) {
    return isMissingFsError(error)
      ? { status: 'missing' }
      : { status: 'invalid', reason: 'unreadable' };
  }
  return undefined;
}

/** Read one cache marker through an explicit descriptor-anchored 4 KiB cap. */
export function readEphemeralMarker(entryDir: string): EphemeralMarkerReadResult {
  const markerPath = join(entryDir, EPHEMERAL_MARKER_FILE);
  const preflight = markerReadPreflight(entryDir, markerPath);
  if (preflight !== undefined) return preflight;
  let fd: number | undefined;
  try {
    fd = openSync(markerPath, 'r');
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { status: 'invalid', reason: 'unreadable' };
    if (stat.size > EPHEMERAL_MARKER_MAX_BYTES) {
      return { status: 'invalid', reason: 'oversize' };
    }
    const buffer = Buffer.alloc(EPHEMERAL_MARKER_MAX_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const count = readSync(fd, buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (count === 0) break;
      bytesRead += count;
    }
    if (bytesRead > EPHEMERAL_MARKER_MAX_BYTES) {
      return { status: 'invalid', reason: 'oversize' };
    }
    return parseEphemeralMarker(buffer.toString('utf8', 0, bytesRead));
  } catch {
    return { status: 'invalid', reason: 'unreadable' };
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // @swallow-ok The bounded read result already fails closed for mutation authority.
      }
    }
  }
}
