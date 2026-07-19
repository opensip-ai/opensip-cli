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

import { lstatSync } from 'node:fs';
import { join } from 'node:path';

import {
  ensureEphemeralRuntimeDirectory,
  ensureEphemeralRuntimeRoot,
} from './ephemeral-runtime-directory.js';
import {
  EPHEMERAL_MARKER_FILE,
  EPHEMERAL_MARKER_MAX_BYTES,
  EPHEMERAL_MARKER_VERSION,
  isValidEphemeralTimestamp,
  parseEphemeralMarker,
  readEphemeralMarker,
  type EphemeralMarker,
  type EphemeralMarkerReadResult,
} from './ephemeral-runtime-marker.js';
import { withFileLock, type FileLockEvent } from './file-lock.js';
import {
  legacyEphemeralProjectCacheKey,
  resolveEphemeralProjectPaths,
  resolveUserPaths,
  type EphemeralProjectIdentityStrength,
  type EphemeralProjectPaths,
} from './paths.js';
import {
  mutateAnchoredRecord,
  readAnchoredRecord,
  type RuntimeLeaseEvent,
} from './runtime-lease.js';

export {
  EPHEMERAL_MARKER_FILE,
  EPHEMERAL_MARKER_MAX_BYTES,
  EPHEMERAL_MARKER_VERSION,
  parseEphemeralMarker,
  readEphemeralMarker,
  type EphemeralMarker,
  type EphemeralMarkerInvalidReason,
  type EphemeralMarkerReadResult,
  type LegacyEphemeralMarker,
} from './ephemeral-runtime-marker.js';

/** Throttle marker: pruning runs at most once per {@link PRUNE_INTERVAL_MS}. */
const PRUNE_STAMP_FILE = '.last-prune';
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MARKER_METADATA_LOCK_FILE = '.project-marker.lock';
const PRUNE_METADATA_LOCK_FILE = '.last-prune.lock';
const CACHE_PERMISSION_POSTURE = 'owner-controlled' as const;
const METADATA_LOCK_POLICY = Object.freeze({
  waitMs: 250,
  staleMs: 30_000,
  heartbeatMs: 5000,
});

/**
 * Retention defaults. A user-global cache cannot be governed by any single
 * project's config (there is no principled "which project wins"), so these are
 * host constants rather than a config surface.
 */
export const DEFAULT_EPHEMERAL_MAX_AGE_DAYS = 30;
export const DEFAULT_EPHEMERAL_KEEP = 50;

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
  /**
   * Path-stable coordination keys already known to be protected by the
   * caller. The active runtime-lease snapshot is unioned with this set.
   */
  readonly protectedCoordinationKeys?: readonly string[];
  readonly onEvent?: (event: RuntimeLeaseEvent | FileLockEvent) => void;
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
  /** Preserved because a live/protected lease or maintenance intent won. */
  readonly skippedActive: number;
  /** Preserved because identity, metadata, or eligibility could not be re-proven. */
  readonly skippedChanged: number;
}

/** Direct-module-only deterministic race checkpoints; not part of the package barrel. */
export const EPHEMERAL_RUNTIME_TEST_HOOKS = Symbol('ephemeral-runtime-test-hooks');

export interface EphemeralRuntimeTestHooks {
  readonly beforeMarkerPublish?: () => void;
  readonly beforePruneStampPublish?: () => void;
  readonly afterActiveSnapshot?: () => void | Promise<void>;
  readonly beforeCandidateRevalidation?: (cacheKey: string) => void | Promise<void>;
  readonly pruneMonotonicNow?: () => number;
}

type EphemeralPathsWithTestHooks = EphemeralProjectPaths & {
  readonly [EPHEMERAL_RUNTIME_TEST_HOOKS]?: EphemeralRuntimeTestHooks;
};

type EphemeralFileLockEventHandler = ((event: FileLockEvent) => void) & {
  readonly [EPHEMERAL_RUNTIME_TEST_HOOKS]?: EphemeralRuntimeTestHooks;
};

function markerForPaths(paths: EphemeralProjectPaths, lastUsedAt: string): EphemeralMarker {
  return {
    version: EPHEMERAL_MARKER_VERSION,
    projectDir: paths.projectDir,
    canonicalRootDigest: paths.canonicalRootDigest,
    identityStrength: paths.identityStrength,
    ...(paths.generationDigest === undefined ? {} : { generationDigest: paths.generationDigest }),
    lastUsedAt,
  };
}

function updateMarkerWhileLocked(
  paths: EphemeralProjectPaths,
  root: string,
  now: number,
  hooks?: EphemeralRuntimeTestHooks,
): void {
  const observed = readAnchoredRecord({
    trustedAnchorDir: root,
    parentDir: paths.runtimeDir,
    basename: EPHEMERAL_MARKER_FILE,
    maxBytes: EPHEMERAL_MARKER_MAX_BYTES,
    permissionPosture: CACHE_PERMISSION_POSTURE,
  });
  const requestedAt = new Date(now).toISOString();
  hooks?.beforeMarkerPublish?.();
  if (observed.status === 'absent') {
    mutateAnchoredRecord({
      trustedAnchorDir: root,
      parentDir: paths.runtimeDir,
      basename: EPHEMERAL_MARKER_FILE,
      operation: 'create',
      content: JSON.stringify(markerForPaths(paths, requestedAt)),
      maxBytes: EPHEMERAL_MARKER_MAX_BYTES,
      permissionPosture: CACHE_PERMISSION_POSTURE,
    });
    return;
  }

  const parsed = parseEphemeralMarker(observed.content);
  if (parsed.status !== 'current' || !markerMatchesActiveIdentity(parsed, paths)) return;
  const current = parsed.marker;
  const monotonicAt = Date.parse(current.lastUsedAt) >= now ? current.lastUsedAt : requestedAt;
  if (monotonicAt === current.lastUsedAt) return;
  mutateAnchoredRecord({
    trustedAnchorDir: root,
    parentDir: paths.runtimeDir,
    basename: EPHEMERAL_MARKER_FILE,
    operation: 'replace',
    content: JSON.stringify({ ...current, lastUsedAt: monotonicAt }),
    expectedContentSha256: observed.sha256,
    maxBytes: EPHEMERAL_MARKER_MAX_BYTES,
    permissionPosture: CACHE_PERMISSION_POSTURE,
  });
}

/**
 * Record that `paths` was used now, creating the runtime directory if needed.
 * Best-effort: a failure to prove and update the marker preserves that entry
 * from pruning and never fails the primary run.
 */
export function touchEphemeralRuntime(
  paths: EphemeralProjectPaths,
  now = Date.now(),
  onEvent?: (event: FileLockEvent) => void,
): void {
  try {
    const root = ensureEphemeralRuntimeDirectory(paths).ephemeralProjectsDir;
    withFileLock(
      join(paths.runtimeDir, MARKER_METADATA_LOCK_FILE),
      {
        policy: METADATA_LOCK_POLICY,
        resource: 'runtime',
        operation: 'ephemeral-marker',
        onEvent,
      },
      () =>
        updateMarkerWhileLocked(
          paths,
          root,
          now,
          (paths as EphemeralPathsWithTestHooks)[EPHEMERAL_RUNTIME_TEST_HOOKS],
        ),
    );
  } catch {
    // intentionally best-effort hygiene; never fail the user run
  }
}

function entryExists(entryDir: string): boolean {
  try {
    lstatSync(entryDir);
    return true;
  } catch {
    // @swallow-ok An inaccessible cache entry is treated as unavailable to callers.
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

function writePruneStampWhileLocked(
  root: string,
  now: number,
  hooks?: EphemeralRuntimeTestHooks,
): boolean {
  const observed = readAnchoredRecord({
    trustedAnchorDir: root,
    parentDir: root,
    basename: PRUNE_STAMP_FILE,
    maxBytes: 64,
    permissionPosture: CACHE_PERMISSION_POSTURE,
  });
  if (observed.status === 'present') {
    if (!isValidEphemeralTimestamp(observed.content)) return false;
    const last = Date.parse(observed.content);
    if (now - last < PRUNE_INTERVAL_MS) return false;
  }
  hooks?.beforePruneStampPublish?.();
  mutateAnchoredRecord({
    trustedAnchorDir: root,
    parentDir: root,
    basename: PRUNE_STAMP_FILE,
    operation: observed.status === 'absent' ? 'create' : 'replace',
    content: new Date(now).toISOString(),
    ...(observed.status === 'present' ? { expectedContentSha256: observed.sha256 } : {}),
    maxBytes: 64,
    permissionPosture: CACHE_PERMISSION_POSTURE,
  });
  return true;
}

/**
 * True when pruning has not run within {@link PRUNE_INTERVAL_MS}. Stamps the
 * cache so the next call inside the window is a cheap no-op — pruning is
 * hygiene, and paying a full cache scan on every CLI invocation is not.
 */
export function shouldPruneEphemeralRuntimes(
  now = Date.now(),
  onEvent?: EphemeralFileLockEventHandler,
): boolean {
  try {
    const root = ensureEphemeralRuntimeRoot().ephemeralProjectsDir;
    const hooks = onEvent?.[EPHEMERAL_RUNTIME_TEST_HOOKS];
    return withFileLock(
      join(root, PRUNE_METADATA_LOCK_FILE),
      {
        policy: METADATA_LOCK_POLICY,
        resource: 'runtime',
        operation: 'ephemeral-prune-stamp',
        onEvent,
      },
      () => writePruneStampWhileLocked(root, now, hooks),
    );
  } catch {
    // @swallow-ok A stamp failure cannot grant prune authority and is reported as false.
    // A stamp publication failure cannot grant deletion authority.
    return false;
  }
}
