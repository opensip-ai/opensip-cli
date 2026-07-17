/**
 * ephemeral-runtime — hygiene for the no-init (pre-`init`) runtime cache.
 *
 * A first run on an uninitialized project writes a full runtime tree (sessions
 * datastore, logs, reports, artifacts) to
 * `~/.opensip-cli/cache/ephemeral/<project-generation-key>/` so that nothing
 * lands in the user's repository. Two consequences follow, and both are handled
 * here:
 *
 * 1. The cache key is a ONE-WAY hash, so an entry cannot be traced back to the
 *    directory/generation it belongs to. Every ephemeral run therefore writes
 *    a small versioned marker (`project.json`) recording its internal identity
 *    proof and `lastUsedAt`. The marker is what makes an orphan or weak legacy
 *    entry identifiable at all.
 * 2. Without pruning the cache grows forever — one directory per project path
 *    ever audited, kept even after that project is deleted, moved, renamed, or
 *    initialized. Retention mirrors the host-owned artifact/session retention
 *    planes: drop orphans, drop stale entries, then bound the total count.
 *
 * Pruning is best-effort hygiene, never load-bearing: every filesystem
 * operation is tolerant, and a failure to prune must never fail a user's run.
 */

import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join } from 'node:path';

import {
  legacyEphemeralProjectCacheKey,
  resolveEphemeralProjectPaths,
  resolveUserPaths,
  type EphemeralProjectIdentityStrength,
  type EphemeralProjectPaths,
} from './paths.js';

/** Marker file recording which project an ephemeral cache entry belongs to. */
export const EPHEMERAL_MARKER_FILE = 'project.json';
/** Current marker schema written beside an ephemeral runtime. */
export const EPHEMERAL_MARKER_VERSION = 2;
/** Hard read cap for the untrusted cache-owned marker. */
export const EPHEMERAL_MARKER_MAX_BYTES = 4096;

/** Throttle marker: pruning runs at most once per {@link PRUNE_INTERVAL_MS}. */
const PRUNE_STAMP_FILE = '.last-prune';
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Retention defaults. A user-global cache cannot be governed by any single
 * project's config (there is no principled "which project wins"), so these are
 * host constants rather than a config surface.
 */
export const DEFAULT_EPHEMERAL_MAX_AGE_DAYS = 30;
export const DEFAULT_EPHEMERAL_KEEP = 50;

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

export type EphemeralMarkerInvalidReason = 'oversize' | 'malformed' | 'unreadable';

/** Bounded, non-throwing result of inspecting one cache marker. */
export type EphemeralMarkerReadResult =
  | { readonly status: 'current'; readonly marker: EphemeralMarker }
  | { readonly status: 'legacy'; readonly marker: LegacyEphemeralMarker }
  | { readonly status: 'missing' }
  | { readonly status: 'invalid'; readonly reason: EphemeralMarkerInvalidReason };

export type EphemeralRuntimeCandidateIdentityStrength =
  EphemeralProjectIdentityStrength | 'legacy-unverified';

/** Read-only path/classification projection for the current project's cache. */
export interface EphemeralRuntimeCandidate {
  readonly kind: 'active' | 'legacy';
  readonly runtimeDir: string;
  readonly cacheKey: string;
  readonly exists: boolean;
  readonly identityStrength: EphemeralRuntimeCandidateIdentityStrength;
  readonly marker: EphemeralMarkerReadResult;
}

export interface EphemeralRuntimeCandidates {
  readonly active: EphemeralRuntimeCandidate;
  /** Present only when a distinct path-key cache directory actually exists. */
  readonly legacy?: EphemeralRuntimeCandidate;
}

export interface PruneEphemeralInput {
  /** Never prune this entry — it backs the run in progress. */
  readonly keepCacheKey?: string;
  readonly maxAgeDays?: number;
  readonly keep?: number;
  /** Injected for determinism in tests. */
  readonly now?: number;
}

export interface PruneEphemeralResult {
  readonly scanned: number;
  /** Removed because the project directory no longer exists. */
  readonly removedOrphaned: number;
  /** Removed because they aged out. */
  readonly removedStale: number;
  /** Removed because the cache exceeded `keep` after the other passes. */
  readonly removedOverflow: number;
}

/**
 * Record that `paths` was used now, creating the runtime directory if needed.
 * Best-effort: a failure to write the marker degrades pruning for that entry
 * (it falls back to directory mtime), never the run.
 */
export function touchEphemeralRuntime(paths: EphemeralProjectPaths, now = Date.now()): void {
  try {
    mkdirSync(paths.runtimeDir, { recursive: true });
    const marker: EphemeralMarker = {
      version: EPHEMERAL_MARKER_VERSION,
      projectDir: paths.projectDir,
      canonicalRootDigest: paths.canonicalRootDigest,
      identityStrength: paths.identityStrength,
      ...(paths.generationDigest === undefined ? {} : { generationDigest: paths.generationDigest }),
      lastUsedAt: new Date(now).toISOString(),
    };
    writeFileSync(join(paths.runtimeDir, EPHEMERAL_MARKER_FILE), JSON.stringify(marker), 'utf8');
  } catch {
    // intentionally best-effort hygiene; never fail the user run
  }
}

function validTimestamp(value: unknown): value is string {
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

function parseMarker(raw: string): EphemeralMarkerReadResult {
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
        !validTimestamp(parsed.lastUsedAt) ||
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
      validTimestamp(parsed.lastUsedAt)
    ) {
      return {
        status: 'legacy',
        marker: { projectDir: parsed.projectDir, lastUsedAt: parsed.lastUsedAt },
      };
    }
    return { status: 'invalid', reason: 'malformed' };
  } catch {
    return { status: 'invalid', reason: 'malformed' };
  }
}

/**
 * Read one marker through an explicit 4 KiB cap. Missing, malformed, oversize,
 * unreadable, symlinked, and special-file markers are distinguished without
 * throwing or mutating the cache.
 */
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

/** Bounded, non-throwing public marker reader used by status and maintenance. */
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
    return parseMarker(buffer.toString('utf8', 0, bytesRead));
  } catch {
    return { status: 'invalid', reason: 'unreadable' };
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Best-effort read helper: closing failure does not make a parsed
        // marker trustworthy enough to mutate anything.
      }
    }
  }
}

function isMissingFsError(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

function entryExists(entryDir: string): boolean {
  try {
    lstatSync(entryDir);
    return true;
  } catch {
    return false;
  }
}

function markerMatchesActiveIdentity(
  marker: EphemeralMarkerReadResult,
  paths: EphemeralProjectPaths,
): boolean {
  if (marker.status !== 'current') return false;
  return (
    marker.marker.projectDir === paths.projectDir &&
    marker.marker.canonicalRootDigest === paths.canonicalRootDigest &&
    marker.marker.identityStrength === paths.identityStrength &&
    marker.marker.generationDigest === paths.generationDigest
  );
}

/**
 * Resolve only the current project's active cache and, when distinct and
 * present, its pre-v2 path-key cache. No other HOME entries are enumerated.
 */
export function inspectEphemeralRuntimeCandidates(projectDir: string): EphemeralRuntimeCandidates {
  const paths = resolveEphemeralProjectPaths(projectDir);
  const activeExists = entryExists(paths.runtimeDir);
  const activeMarker = readEphemeralMarker(paths.runtimeDir);
  const active: EphemeralRuntimeCandidate = {
    kind: 'active',
    runtimeDir: paths.runtimeDir,
    cacheKey: paths.cacheKey,
    exists: activeExists,
    identityStrength:
      (!activeExists && activeMarker.status === 'missing') ||
      markerMatchesActiveIdentity(activeMarker, paths)
        ? paths.identityStrength
        : 'legacy-unverified',
    marker: activeMarker,
  };

  const legacyKey = legacyEphemeralProjectCacheKey(paths.projectDir);
  if (legacyKey === paths.cacheKey) return { active };
  const legacyDir = join(resolveUserPaths().ephemeralProjectsDir, legacyKey);
  if (!entryExists(legacyDir)) return { active };
  return {
    active,
    legacy: {
      kind: 'legacy',
      runtimeDir: legacyDir,
      cacheKey: legacyKey,
      exists: true,
      identityStrength: 'legacy-unverified',
      marker: readEphemeralMarker(legacyDir),
    },
  };
}

/** Last-used time for an entry: marker first, directory mtime for legacy entries. */
function lastUsedAt(entryDir: string, marker: EphemeralMarkerReadResult): number {
  if (marker.status === 'current' || marker.status === 'legacy') {
    const parsed = Date.parse(marker.marker.lastUsedAt);
    if (!Number.isNaN(parsed)) return parsed;
  }
  try {
    return statSync(entryDir).mtimeMs;
  } catch {
    // intentionally best-effort hygiene; never fail the user run
    return 0;
  }
}

function removeEntry(entryDir: string): boolean {
  try {
    rmSync(entryDir, { recursive: true, force: true });
    return true;
  } catch {
    // intentionally best-effort hygiene; never fail the user run
    return false;
  }
}

/**
 * True when pruning has not run within {@link PRUNE_INTERVAL_MS}. Stamps the
 * cache so the next call inside the window is a cheap no-op — pruning is
 * hygiene, and paying a full cache scan on every CLI invocation is not.
 */
export function shouldPruneEphemeralRuntimes(now = Date.now()): boolean {
  const stampPath = join(resolveUserPaths().ephemeralProjectsDir, PRUNE_STAMP_FILE);
  try {
    const last = Date.parse(readFileSync(stampPath, 'utf8'));
    if (!Number.isNaN(last) && now - last < PRUNE_INTERVAL_MS) return false;
  } catch {
    // intentionally best-effort hygiene; never fail the user run
  }
  try {
    mkdirSync(resolveUserPaths().ephemeralProjectsDir, { recursive: true });
    writeFileSync(stampPath, new Date(now).toISOString(), 'utf8');
  } catch {
    // intentionally best-effort hygiene; never fail the user run
  }
  return true;
}

/** Cache-entry directory names, or `[]` when the cache does not exist yet. */
function listEntries(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    // intentionally best-effort hygiene; never fail the user run
    return [];
  }
}

type Verdict = 'orphaned' | 'stale' | 'keep';

/**
 * Why (if at all) an entry should go. An entry with no marker predates this
 * plane and cannot be orphan-checked — it is judged on age alone rather than
 * deleted on suspicion.
 */
function classifyEntry(
  marker: EphemeralMarkerReadResult,
  usedAt: number,
  now: number,
  maxAgeMs: number,
): Verdict {
  if (
    (marker.status === 'current' || marker.status === 'legacy') &&
    !existsSync(marker.marker.projectDir)
  ) {
    return 'orphaned';
  }
  if (now - usedAt > maxAgeMs) return 'stale';
  return 'keep';
}

/** Drop the oldest survivors until at most `keep` remain. */
function pruneOverflow(
  root: string,
  survivors: readonly { readonly key: string; readonly usedAt: number }[],
  keep: number,
): number {
  if (keep <= 0 || survivors.length <= keep) return 0;
  const oldestFirst = [...survivors].sort((a, b) => a.usedAt - b.usedAt);
  let removed = 0;
  for (const entry of oldestFirst.slice(0, survivors.length - keep)) {
    if (removeEntry(join(root, entry.key))) removed++;
  }
  return removed;
}

/**
 * Drop ephemeral cache entries that can no longer be useful:
 *   1. ORPHANED — the project directory they belong to no longer exists (it was
 *      deleted, moved, or renamed; the path hash can never match again).
 *   2. STALE — untouched for longer than `maxAgeDays`.
 *   3. OVERFLOW — beyond `keep`, oldest first.
 *
 * The entry backing the current run (`keepCacheKey`) is never removed. Entries
 * with no marker (written before this plane existed) cannot be orphan-checked
 * and are judged on age/overflow alone.
 */
export function pruneEphemeralRuntimes(input: PruneEphemeralInput = {}): PruneEphemeralResult {
  const now = input.now ?? Date.now();
  const maxAgeDays = input.maxAgeDays ?? DEFAULT_EPHEMERAL_MAX_AGE_DAYS;
  const keep = input.keep ?? DEFAULT_EPHEMERAL_KEEP;
  const root = resolveUserPaths().ephemeralProjectsDir;
  const entries = listEntries(root);
  const maxAgeMs = maxAgeDays <= 0 ? Number.POSITIVE_INFINITY : maxAgeDays * 24 * 60 * 60 * 1000;

  const survivors: { readonly key: string; readonly usedAt: number }[] = [];
  let removedOrphaned = 0;
  let removedStale = 0;

  for (const key of entries) {
    if (key === input.keepCacheKey) continue;
    const entryDir = join(root, key);
    const marker = readEphemeralMarker(entryDir);
    const usedAt = lastUsedAt(entryDir, marker);

    switch (classifyEntry(marker, usedAt, now, maxAgeMs)) {
      case 'orphaned': {
        if (removeEntry(entryDir)) removedOrphaned++;
        break;
      }
      case 'stale': {
        if (removeEntry(entryDir)) removedStale++;
        break;
      }
      default: {
        survivors.push({ key, usedAt });
      }
    }
  }

  return {
    scanned: entries.length,
    removedOrphaned,
    removedStale,
    removedOverflow: pruneOverflow(root, survivors, keep),
  };
}
