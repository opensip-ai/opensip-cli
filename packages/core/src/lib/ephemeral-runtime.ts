/**
 * ephemeral-runtime — hygiene for the no-init (pre-`init`) runtime cache.
 *
 * A first run on an uninitialized project writes a full runtime tree (sessions
 * datastore, logs, reports, artifacts) to
 * `~/.opensip-cli/cache/ephemeral/<sha256(projectDir)>/` so that nothing lands
 * in the user's repository. Two consequences follow, and both are handled here:
 *
 * 1. The cache key is a ONE-WAY hash, so an entry cannot be traced back to the
 *    directory it belongs to. Every ephemeral run therefore writes a small
 *    marker (`project.json`) recording its `projectDir` and `lastUsedAt`. The
 *    marker is what makes an orphan identifiable at all.
 * 2. Without pruning the cache grows forever — one directory per project path
 *    ever audited, kept even after that project is deleted, moved, renamed, or
 *    initialized. Retention mirrors the host-owned artifact/session retention
 *    planes: drop orphans, drop stale entries, then bound the total count.
 *
 * Pruning is best-effort hygiene, never load-bearing: every filesystem
 * operation is tolerant, and a failure to prune must never fail a user's run.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { resolveUserPaths, type EphemeralProjectPaths } from './paths.js';

/** Marker file recording which project an ephemeral cache entry belongs to. */
export const EPHEMERAL_MARKER_FILE = 'project.json';

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
  /** Absolute project directory this runtime backs. */
  readonly projectDir: string;
  /** ISO timestamp of the most recent run against it. */
  readonly lastUsedAt: string;
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
      projectDir: paths.projectDir,
      lastUsedAt: new Date(now).toISOString(),
    };
    writeFileSync(join(paths.runtimeDir, EPHEMERAL_MARKER_FILE), JSON.stringify(marker), 'utf8');
  } catch {
    // Hygiene only — never fail a run because the cache marker could not be written.
  }
}

function readMarker(entryDir: string): EphemeralMarker | undefined {
  try {
    const raw = readFileSync(join(entryDir, EPHEMERAL_MARKER_FILE), 'utf8');
    const parsed = JSON.parse(raw) as Partial<EphemeralMarker>;
    if (typeof parsed.projectDir !== 'string' || typeof parsed.lastUsedAt !== 'string') {
      return undefined;
    }
    return { projectDir: parsed.projectDir, lastUsedAt: parsed.lastUsedAt };
  } catch {
    return undefined;
  }
}

/** Last-used time for an entry: marker first, directory mtime for legacy entries. */
function lastUsedAt(entryDir: string, marker: EphemeralMarker | undefined): number {
  if (marker !== undefined) {
    const parsed = Date.parse(marker.lastUsedAt);
    if (!Number.isNaN(parsed)) return parsed;
  }
  try {
    return statSync(entryDir).mtimeMs;
  } catch {
    return 0;
  }
}

function removeEntry(entryDir: string): boolean {
  try {
    rmSync(entryDir, { recursive: true, force: true });
    return true;
  } catch {
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
    // No stamp (or unreadable) — treat as due.
  }
  try {
    mkdirSync(resolveUserPaths().ephemeralProjectsDir, { recursive: true });
    writeFileSync(stampPath, new Date(now).toISOString(), 'utf8');
  } catch {
    // If the stamp cannot be written we still prune; we just may prune again sooner.
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
  marker: EphemeralMarker | undefined,
  usedAt: number,
  now: number,
  maxAgeMs: number,
): Verdict {
  if (marker !== undefined && !existsSync(marker.projectDir)) return 'orphaned';
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
    const marker = readMarker(entryDir);
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
