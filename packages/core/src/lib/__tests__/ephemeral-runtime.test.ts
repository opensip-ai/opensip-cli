import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_EPHEMERAL_KEEP,
  EPHEMERAL_MARKER_FILE,
  EPHEMERAL_MARKER_MAX_BYTES,
  EPHEMERAL_MARKER_VERSION,
  inspectEphemeralRuntimeCandidates,
  pruneEphemeralRuntimes,
  readEphemeralMarker,
  shouldPruneEphemeralRuntimes,
  touchEphemeralRuntime,
} from '../ephemeral-runtime.js';
import {
  ephemeralProjectCacheKey,
  legacyEphemeralProjectCacheKey,
  resolveEphemeralProjectPaths,
  resolveUserPaths,
} from '../paths.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-07-13T12:00:00.000Z');

let home: string;
let priorHome: string | undefined;

/** Seed one ephemeral cache entry for `projectDir`, last used `ageDays` ago. */
function seedEntry(projectDir: string, ageDays: number, opts: { marker?: boolean } = {}): string {
  const key = ephemeralProjectCacheKey(projectDir);
  const dir = join(resolveUserPaths().ephemeralProjectsDir, key);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'datastore.sqlite'), 'x', 'utf8');
  if (opts.marker !== false) {
    writeFileSync(
      join(dir, EPHEMERAL_MARKER_FILE),
      JSON.stringify({ projectDir, lastUsedAt: new Date(NOW - ageDays * DAY_MS).toISOString() }),
      'utf8',
    );
  }
  return dir;
}

beforeEach(() => {
  priorHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), 'opensip-ephemeral-'));
  process.env.HOME = home;
});

afterEach(() => {
  if (priorHome === undefined) delete process.env.HOME;
  else process.env.HOME = priorHome;
  rmSync(home, { recursive: true, force: true });
});

describe('ephemeral runtime cache', () => {
  it('writes and reads a bounded v2 marker with generation identity', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'opensip-proj-'));
    const paths = resolveEphemeralProjectPaths(projectDir);

    touchEphemeralRuntime(paths, NOW);

    const result = readEphemeralMarker(paths.runtimeDir);
    expect(result).toEqual({
      status: 'current',
      marker: {
        version: EPHEMERAL_MARKER_VERSION,
        projectDir: paths.projectDir,
        canonicalRootDigest: paths.canonicalRootDigest,
        identityStrength: paths.identityStrength,
        generationDigest: paths.generationDigest,
        lastUsedAt: new Date(NOW).toISOString(),
      },
    });
    expect(
      Buffer.byteLength(readFileSync(join(paths.runtimeDir, EPHEMERAL_MARKER_FILE), 'utf8')),
    ).toBeLessThanOrEqual(EPHEMERAL_MARKER_MAX_BYTES);
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('classifies an old unversioned marker as legacy', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'opensip-legacy-marker-'));
    const entryDir = seedEntry(projectDir, 1);

    expect(readEphemeralMarker(entryDir)).toEqual({
      status: 'legacy',
      marker: {
        projectDir,
        lastUsedAt: new Date(NOW - DAY_MS).toISOString(),
      },
    });
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('distinguishes missing, malformed, oversize, and symlink markers', () => {
    const entryDir = join(resolveUserPaths().ephemeralProjectsDir, 'marker-cases');
    mkdirSync(entryDir, { recursive: true });
    expect(readEphemeralMarker(entryDir)).toEqual({ status: 'missing' });

    const markerPath = join(entryDir, EPHEMERAL_MARKER_FILE);
    writeFileSync(markerPath, '{not-json');
    expect(readEphemeralMarker(entryDir)).toEqual({
      status: 'invalid',
      reason: 'malformed',
    });

    writeFileSync(markerPath, 'x'.repeat(EPHEMERAL_MARKER_MAX_BYTES + 1));
    expect(readEphemeralMarker(entryDir)).toEqual({
      status: 'invalid',
      reason: 'oversize',
    });

    if (platform() !== 'win32') {
      rmSync(markerPath);
      const target = join(entryDir, 'target.json');
      writeFileSync(target, '{}');
      symlinkSync(target, markerPath);
      expect(readEphemeralMarker(entryDir)).toEqual({
        status: 'invalid',
        reason: 'unreadable',
      });
    }
  });

  it('verifies the active marker and reports a distinct legacy path candidate', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'opensip-candidates-'));
    const paths = resolveEphemeralProjectPaths(projectDir);
    touchEphemeralRuntime(paths, NOW);

    const legacyKey = legacyEphemeralProjectCacheKey(projectDir);
    expect(legacyKey).not.toBe(paths.cacheKey);
    const legacyDir = join(resolveUserPaths().ephemeralProjectsDir, legacyKey);
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(
      join(legacyDir, EPHEMERAL_MARKER_FILE),
      JSON.stringify({ projectDir, lastUsedAt: new Date(NOW - DAY_MS).toISOString() }),
    );

    const candidates = inspectEphemeralRuntimeCandidates(projectDir);
    expect(candidates.active).toMatchObject({
      kind: 'active',
      runtimeDir: paths.runtimeDir,
      exists: true,
      identityStrength: 'generation-bound',
      marker: { status: 'current' },
    });
    expect(candidates.legacy).toMatchObject({
      kind: 'legacy',
      runtimeDir: legacyDir,
      exists: true,
      identityStrength: 'legacy-unverified',
      marker: { status: 'legacy' },
    });
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('downgrades an existing active cache whose marker cannot prove its identity', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'opensip-mismatch-'));
    const paths = resolveEphemeralProjectPaths(projectDir);
    mkdirSync(paths.runtimeDir, { recursive: true });
    writeFileSync(
      join(paths.runtimeDir, EPHEMERAL_MARKER_FILE),
      JSON.stringify({
        version: EPHEMERAL_MARKER_VERSION,
        projectDir: paths.projectDir,
        canonicalRootDigest: '0'.repeat(64),
        identityStrength: paths.identityStrength,
        generationDigest: paths.generationDigest,
        lastUsedAt: new Date(NOW).toISOString(),
      }),
    );

    expect(inspectEphemeralRuntimeCandidates(projectDir).active.identityStrength).toBe(
      'legacy-unverified',
    );
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('keeps a missing path-only candidate weak and performs no project write', () => {
    const projectDir = join(home, 'never-created-project');
    const candidates = inspectEphemeralRuntimeCandidates(projectDir);

    expect(candidates.active).toMatchObject({
      exists: false,
      identityStrength: 'path-only',
      marker: { status: 'missing' },
    });
    expect(candidates.legacy).toBeUndefined();
    expect(existsSync(projectDir)).toBe(false);
  });

  it('continues path-only reads and writes with explicit weak identity disclosure', () => {
    const projectDir = join(home, 'path-only-project');
    const paths = resolveEphemeralProjectPaths(projectDir);
    expect(paths.identityStrength).toBe('path-only');

    touchEphemeralRuntime(paths, NOW);

    expect(inspectEphemeralRuntimeCandidates(projectDir).active).toMatchObject({
      exists: true,
      identityStrength: 'path-only',
      marker: {
        status: 'current',
        marker: {
          identityStrength: 'path-only',
          projectDir,
        },
      },
    });
    expect(existsSync(projectDir)).toBe(false);
  });

  it('removes entries whose project directory no longer exists', () => {
    const gone = join(home, 'deleted-project');
    const alive = mkdtempSync(join(tmpdir(), 'opensip-alive-'));
    const orphanDir = seedEntry(gone, 1);
    const aliveDir = seedEntry(alive, 1);

    const result = pruneEphemeralRuntimes({ now: NOW });

    expect(result.removedOrphaned).toBe(1);
    expect(existsSync(orphanDir)).toBe(false);
    expect(existsSync(aliveDir)).toBe(true);
    rmSync(alive, { recursive: true, force: true });
  });

  it('removes entries that aged out, and keeps recent ones', () => {
    const project = mkdtempSync(join(tmpdir(), 'opensip-alive-'));
    const stale = seedEntry(project, 90);

    const result = pruneEphemeralRuntimes({ now: NOW, maxAgeDays: 30 });

    expect(result.removedStale).toBe(1);
    expect(existsSync(stale)).toBe(false);
    rmSync(project, { recursive: true, force: true });
  });

  it('never removes the entry backing the run in progress', () => {
    // Orphaned AND ancient — it would be removed on both counts if not held.
    const gone = join(home, 'deleted-but-current');
    const dir = seedEntry(gone, 999);

    const result = pruneEphemeralRuntimes({
      now: NOW,
      keepCacheKey: ephemeralProjectCacheKey(gone),
    });

    expect(result.removedOrphaned).toBe(0);
    expect(result.removedStale).toBe(0);
    expect(existsSync(dir)).toBe(true);
  });

  it('bounds the cache by keep, dropping the oldest survivors first', () => {
    const projects = Array.from({ length: 4 }, () => mkdtempSync(join(tmpdir(), 'opensip-p-')));
    const dirs = projects.map((project, index) => seedEntry(project, index));

    const result = pruneEphemeralRuntimes({ now: NOW, keep: 2 });

    expect(result.removedOverflow).toBe(2);
    // Index 0/1 are the most recently used; 2/3 are the oldest and go first.
    expect(existsSync(String(dirs[0]))).toBe(true);
    expect(existsSync(String(dirs[1]))).toBe(true);
    expect(existsSync(String(dirs[2]))).toBe(false);
    expect(existsSync(String(dirs[3]))).toBe(false);
    for (const project of projects) rmSync(project, { recursive: true, force: true });
  });

  it('judges legacy (marker-less) entries on age alone rather than deleting them blindly', () => {
    const project = mkdtempSync(join(tmpdir(), 'opensip-legacy-'));
    const dir = seedEntry(project, 0, { marker: false });

    const result = pruneEphemeralRuntimes({ now: NOW, maxAgeDays: 30 });

    // Fresh mtime, no marker: cannot be orphan-checked, must not be removed.
    expect(result.removedOrphaned).toBe(0);
    expect(existsSync(dir)).toBe(true);
    rmSync(project, { recursive: true, force: true });
  });

  it('tolerates a missing cache directory', () => {
    expect(pruneEphemeralRuntimes({ now: NOW })).toEqual({
      scanned: 0,
      removedOrphaned: 0,
      removedStale: 0,
      removedOverflow: 0,
    });
  });

  it('throttles to once per day', () => {
    expect(shouldPruneEphemeralRuntimes(NOW)).toBe(true);
    expect(shouldPruneEphemeralRuntimes(NOW + 60_000)).toBe(false);
    expect(shouldPruneEphemeralRuntimes(NOW + 2 * DAY_MS)).toBe(true);
  });

  it('exposes a sane default retention bound', () => {
    expect(DEFAULT_EPHEMERAL_KEEP).toBeGreaterThan(0);
  });
});
