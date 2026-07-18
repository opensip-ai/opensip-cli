import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { platform, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { pruneEphemeralRuntimes } from '../ephemeral-runtime-prune.js';
import {
  DEFAULT_EPHEMERAL_KEEP,
  EPHEMERAL_RUNTIME_TEST_HOOKS,
  EPHEMERAL_MARKER_FILE,
  EPHEMERAL_MARKER_MAX_BYTES,
  EPHEMERAL_MARKER_VERSION,
  inspectEphemeralRuntimeCandidates,
  readEphemeralMarker,
  shouldPruneEphemeralRuntimes,
  touchEphemeralRuntime,
  type EphemeralRuntimeTestHooks,
} from '../ephemeral-runtime.js';
import {
  legacyEphemeralProjectCacheKey,
  projectCoordinationKey,
  resolveCoordinationPaths,
  resolveEphemeralProjectPaths,
  resolveUserPaths,
} from '../paths.js';
import { acquireRuntimeReadLease, listActiveRuntimeLeaseKeys } from '../runtime-lease.js';

import type { FileLockEvent } from '../file-lock.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-07-13T12:00:00.000Z');

let home: string;
let priorHome: string | undefined;

function coreEntryPath(): string {
  return fileURLToPath(new URL('../../../dist/index.js', import.meta.url));
}

function waitForChildOutput(
  child: ChildProcessWithoutNullStreams,
  expected: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => finish(new Error(`Timed out waiting for ${expected}`)), 10_000);
    const onData = (chunk: Buffer): void => {
      output += chunk.toString('utf8');
      if (output.includes(expected)) finish();
    };
    const onError = (error: Error): void => finish(error);
    const onExit = (code: number | null): void =>
      finish(new Error(`Child exited ${String(code)} before ${expected}`));
    const finish = (error?: Error): void => {
      clearTimeout(timer);
      child.stdout.off('data', onData);
      child.off('error', onError);
      child.off('exit', onExit);
      if (error === undefined) resolve(output);
      else reject(error);
    };
    child.stdout.on('data', onData);
    child.on('error', onError);
    child.on('exit', onExit);
  });
}

/** Seed one ephemeral cache entry for `projectDir`, last used `ageDays` ago. */
function seedEntry(projectDir: string, ageDays: number, opts: { marker?: boolean } = {}): string {
  const paths = resolveEphemeralProjectPaths(projectDir);
  const dir = paths.runtimeDir;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'datastore.sqlite'), 'x', 'utf8');
  if (opts.marker !== false) {
    touchEphemeralRuntime(paths, NOW - ageDays * DAY_MS);
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

  it('advances lastUsedAt monotonically without changing marker identity', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'opensip-monotonic-marker-'));
    const paths = resolveEphemeralProjectPaths(projectDir);

    touchEphemeralRuntime(paths, NOW);
    touchEphemeralRuntime(paths, NOW - DAY_MS);
    touchEphemeralRuntime(paths, NOW + DAY_MS);

    expect(readEphemeralMarker(paths.runtimeDir)).toEqual({
      status: 'current',
      marker: {
        version: EPHEMERAL_MARKER_VERSION,
        projectDir: paths.projectDir,
        canonicalRootDigest: paths.canonicalRootDigest,
        identityStrength: paths.identityStrength,
        generationDigest: paths.generationDigest,
        lastUsedAt: new Date(NOW + DAY_MS).toISOString(),
      },
    });
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('serializes concurrent marker touches and retains the newest timestamp', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'opensip-concurrent-marker-'));
    const worker = String.raw`
      import { pathToFileURL } from "node:url";
      const core = await import(pathToFileURL(process.argv[1]).href);
      const paths = core.resolveEphemeralProjectPaths(process.argv[2]);
      const lease = await core.acquireRuntimeReadLease({
        projectDir: process.argv[2],
        policy: { waitMs: 5000, staleMs: 5000, heartbeatMs: 100, pollMs: 5 },
      });
      process.stdout.write("READY\n");
      process.stdin.once("data", () => {
        core.touchEphemeralRuntime(paths, Number(process.argv[3]));
        lease.release();
        process.stdout.write("DONE\n");
        process.exit(0);
      });
    `;
    const children = [NOW, NOW + DAY_MS].map((timestamp) =>
      spawn(process.execPath, [
        '--input-type=module',
        '--eval',
        worker,
        coreEntryPath(),
        projectDir,
        String(timestamp),
      ]),
    );
    try {
      await Promise.all(children.map((child) => waitForChildOutput(child, 'READY\n')));
      const completions = children.map((child) => waitForChildOutput(child, 'DONE\n'));
      for (const child of children) child.stdin.write('GO\n');
      await Promise.all(completions);

      const marker = readEphemeralMarker(resolveEphemeralProjectPaths(projectDir).runtimeDir);
      expect(marker.status).toBe('current');
      if (marker.status === 'current') {
        expect(marker.marker.lastUsedAt).toBe(new Date(NOW + DAY_MS).toISOString());
      }
    } finally {
      for (const child of children) {
        if (child.exitCode === null) child.kill();
      }
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it.runIf(platform() !== 'win32')(
    'rejects symlinked cache parents before creating external markers or locks',
    async () => {
      const projectDir = mkdtempSync(join(tmpdir(), 'opensip-symlink-parent-'));
      const paths = resolveEphemeralProjectPaths(projectDir);
      const userPaths = resolveUserPaths();

      for (const symlinkedLevel of ['cache', 'ephemeral'] as const) {
        rmSync(userPaths.userHomeDir, { recursive: true, force: true });
        mkdirSync(userPaths.userHomeDir, { recursive: true, mode: 0o700 });
        const outside = mkdtempSync(join(tmpdir(), `opensip-outside-${symlinkedLevel}-`));
        if (symlinkedLevel === 'cache') {
          symlinkSync(outside, userPaths.cacheDir, 'dir');
        } else {
          mkdirSync(userPaths.cacheDir, { mode: 0o700 });
          symlinkSync(outside, userPaths.ephemeralProjectsDir, 'dir');
        }

        touchEphemeralRuntime(paths, NOW);
        expect(shouldPruneEphemeralRuntimes(NOW)).toBe(false);
        await expect(pruneEphemeralRuntimes({ now: NOW })).resolves.toEqual({
          scanned: 0,
          removedOrphaned: 0,
          removedStale: 0,
          removedOverflow: 0,
          skippedActive: 0,
          skippedChanged: 0,
        });
        expect(readdirSync(outside)).toEqual([]);
        rmSync(outside, { recursive: true, force: true });
      }
      rmSync(projectDir, { recursive: true, force: true });
    },
  );

  it.runIf(platform() !== 'win32')(
    'rejects a symlinked cache-key directory before creating an external marker or lock',
    () => {
      const projectDir = mkdtempSync(join(tmpdir(), 'opensip-symlink-entry-'));
      const paths = resolveEphemeralProjectPaths(projectDir);
      const outside = mkdtempSync(join(tmpdir(), 'opensip-outside-entry-'));
      mkdirSync(resolveUserPaths().ephemeralProjectsDir, { recursive: true, mode: 0o700 });
      symlinkSync(outside, paths.runtimeDir, 'dir');

      touchEphemeralRuntime(paths, NOW);

      expect(readdirSync(outside)).toEqual([]);
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    },
  );

  it('preserves malformed and identity-mismatched markers during touch', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'opensip-marker-preserve-'));
    const paths = resolveEphemeralProjectPaths(projectDir);
    mkdirSync(paths.runtimeDir, { recursive: true });
    const markerPath = join(paths.runtimeDir, EPHEMERAL_MARKER_FILE);

    writeFileSync(markerPath, '{not-json');
    touchEphemeralRuntime(paths, NOW);
    expect(readFileSync(markerPath, 'utf8')).toBe('{not-json');

    const mismatched = JSON.stringify({
      version: EPHEMERAL_MARKER_VERSION,
      projectDir: paths.projectDir,
      canonicalRootDigest: '0'.repeat(64),
      identityStrength: paths.identityStrength,
      generationDigest: paths.generationDigest,
      lastUsedAt: new Date(NOW - DAY_MS).toISOString(),
    });
    writeFileSync(markerPath, mismatched);
    touchEphemeralRuntime(paths, NOW);
    expect(readFileSync(markerPath, 'utf8')).toBe(mismatched);
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('preserves a concurrently replaced marker when marker CAS loses', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'opensip-marker-cas-'));
    const paths = resolveEphemeralProjectPaths(projectDir);
    touchEphemeralRuntime(paths, NOW);
    const markerPath = join(paths.runtimeDir, EPHEMERAL_MARKER_FILE);
    const replacement = JSON.stringify({
      version: EPHEMERAL_MARKER_VERSION,
      projectDir: paths.projectDir,
      canonicalRootDigest: paths.canonicalRootDigest,
      identityStrength: paths.identityStrength,
      generationDigest: paths.generationDigest,
      lastUsedAt: new Date(NOW + 2 * DAY_MS).toISOString(),
    });
    const hookedPaths = {
      ...paths,
      [EPHEMERAL_RUNTIME_TEST_HOOKS]: {
        beforeMarkerPublish: () => writeFileSync(markerPath, replacement),
      },
    };

    touchEphemeralRuntime(hookedPaths, NOW + DAY_MS);

    expect(readFileSync(markerPath, 'utf8')).toBe(replacement);
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('classifies an old unversioned marker as legacy', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'opensip-legacy-marker-'));
    const entryDir = join(
      resolveUserPaths().ephemeralProjectsDir,
      legacyEphemeralProjectCacheKey(projectDir),
    );
    mkdirSync(entryDir, { recursive: true });
    writeFileSync(
      join(entryDir, EPHEMERAL_MARKER_FILE),
      JSON.stringify({
        projectDir,
        lastUsedAt: new Date(NOW - DAY_MS).toISOString(),
      }),
    );

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
      JSON.stringify({
        projectDir,
        lastUsedAt: new Date(NOW - DAY_MS).toISOString(),
      }),
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

  it('removes entries whose project directory no longer exists', async () => {
    const gone = join(home, 'deleted-project');
    const alive = mkdtempSync(join(tmpdir(), 'opensip-alive-'));
    const orphanDir = seedEntry(gone, 1);
    const aliveDir = seedEntry(alive, 1);

    const result = await pruneEphemeralRuntimes({ now: NOW });

    expect(result.removedOrphaned).toBe(1);
    expect(existsSync(orphanDir)).toBe(false);
    expect(existsSync(aliveDir)).toBe(true);
    rmSync(alive, { recursive: true, force: true });
  });

  it('removes entries that aged out, and keeps recent ones', async () => {
    const project = mkdtempSync(join(tmpdir(), 'opensip-alive-'));
    const stale = seedEntry(project, 90);

    const result = await pruneEphemeralRuntimes({ now: NOW, maxAgeDays: 30 });

    expect(result.removedStale).toBe(1);
    expect(existsSync(stale)).toBe(false);
    rmSync(project, { recursive: true, force: true });
  });

  it('never removes an explicitly protected project generation', async () => {
    // Orphaned AND ancient — it would be removed on both counts if not held.
    const gone = join(home, 'deleted-but-current');
    const dir = seedEntry(gone, 999);

    const result = await pruneEphemeralRuntimes({
      now: NOW,
      protectedCoordinationKeys: [projectCoordinationKey(gone)],
    });

    expect(result.removedOrphaned).toBe(0);
    expect(result.removedStale).toBe(0);
    expect(result.skippedActive).toBe(1);
    expect(existsSync(dir)).toBe(true);
  });

  it('preserves a candidate protected by a live reader lease', async () => {
    const gone = join(home, 'active-deleted-project');
    const dir = seedEntry(gone, 999);
    const lease = await acquireRuntimeReadLease({
      projectDir: gone,
      policy: { waitMs: 100, staleMs: 300, heartbeatMs: 50, pollMs: 2 },
    });
    try {
      const result = await pruneEphemeralRuntimes({ now: NOW });
      expect(result).toMatchObject({
        removedOrphaned: 0,
        removedStale: 0,
        skippedActive: 1,
      });
      expect(existsSync(dir)).toBe(true);
    } finally {
      lease.release();
    }
  });

  it('preserves active generation-bound and legacy candidates across stale pruning', async () => {
    const project = mkdtempSync(join(tmpdir(), 'opensip-active-generations-'));
    const currentDir = seedEntry(project, 999);
    const legacyDir = join(
      resolveUserPaths().ephemeralProjectsDir,
      legacyEphemeralProjectCacheKey(project),
    );
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(
      join(legacyDir, EPHEMERAL_MARKER_FILE),
      JSON.stringify({
        projectDir: project,
        lastUsedAt: new Date(NOW - 999 * DAY_MS).toISOString(),
      }),
    );
    const lease = await acquireRuntimeReadLease({
      projectDir: project,
      policy: { waitMs: 100, staleMs: 300, heartbeatMs: 50, pollMs: 2 },
    });
    try {
      const result = await pruneEphemeralRuntimes({ now: NOW, maxAgeDays: 30 });
      expect(result).toMatchObject({
        removedStale: 0,
        skippedActive: 2,
      });
      expect(existsSync(currentDir)).toBe(true);
      expect(existsSync(legacyDir)).toBe(true);
    } finally {
      lease.release();
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('blocks deletion when a reader registers after the active-key snapshot', async () => {
    const gone = join(home, 'late-reader-project');
    const dir = seedEntry(gone, 999);
    let lease: Awaited<ReturnType<typeof acquireRuntimeReadLease>> | undefined;
    const input = {
      now: NOW,
      [EPHEMERAL_RUNTIME_TEST_HOOKS]: {
        afterActiveSnapshot: async () => {
          lease = await acquireRuntimeReadLease({
            projectDir: gone,
            policy: { waitMs: 100, staleMs: 300, heartbeatMs: 50, pollMs: 2 },
          });
        },
      },
    };
    try {
      const result = await pruneEphemeralRuntimes(input);
      expect(result).toMatchObject({
        removedOrphaned: 0,
        skippedActive: 1,
      });
      expect(existsSync(dir)).toBe(true);
    } finally {
      lease?.release();
    }
  });

  it('preserves a candidate whose marker changes before lease-held revalidation', async () => {
    const gone = join(home, 'changed-candidate-project');
    const dir = seedEntry(gone, 999);
    const markerPath = join(dir, EPHEMERAL_MARKER_FILE);
    const original = readEphemeralMarker(dir);
    expect(original.status).toBe('current');
    let mutated = false;
    const input = {
      now: NOW,
      [EPHEMERAL_RUNTIME_TEST_HOOKS]: {
        beforeCandidateRevalidation: () => {
          if (mutated || original.status !== 'current') return;
          mutated = true;
          writeFileSync(
            markerPath,
            JSON.stringify({
              ...original.marker,
              lastUsedAt: new Date(NOW + DAY_MS).toISOString(),
            }),
          );
        },
      },
    };
    const result = await pruneEphemeralRuntimes(input);

    expect(result).toMatchObject({
      removedOrphaned: 0,
      skippedChanged: 1,
    });
    expect(existsSync(dir)).toBe(true);
  });

  it('stops candidate deletion when the monotonic prune budget expires', async () => {
    const gone = [0, 1, 2].map((index) => join(home, `budget-expired-project-${index}`));
    const dirs = gone.map((project) => seedEntry(project, 999));
    let monotonicNow = 0;
    const input = {
      now: NOW,
      [EPHEMERAL_RUNTIME_TEST_HOOKS]: {
        pruneMonotonicNow: () => monotonicNow,
        beforeCandidateRevalidation: () => {
          monotonicNow = 2000;
        },
      },
    };

    const result = await pruneEphemeralRuntimes(input);

    expect(result).toMatchObject({
      removedOrphaned: 0,
      removedStale: 0,
      removedOverflow: 0,
      skippedChanged: 1,
    });
    for (const dir of dirs) expect(existsSync(dir)).toBe(true);
  });

  it('fails the prune pass closed for an invalid protected coordination key', async () => {
    const gone = join(home, 'invalid-protection-project');
    const dir = seedEntry(gone, 999);

    await expect(
      pruneEphemeralRuntimes({
        now: NOW,
        protectedCoordinationKeys: ['not-a-coordination-key'],
      }),
    ).resolves.toEqual({
      scanned: 0,
      removedOrphaned: 0,
      removedStale: 0,
      removedOverflow: 0,
      skippedActive: 0,
      skippedChanged: 0,
    });
    expect(existsSync(dir)).toBe(true);
  });

  it.each([
    ['negative now', { now: -1 }],
    ['non-finite now', { now: Number.NaN }],
    ['negative max age', { now: NOW, maxAgeDays: -1 }],
    ['non-finite max age', { now: NOW, maxAgeDays: Number.POSITIVE_INFINITY }],
    ['negative keep', { now: NOW, keep: -1 }],
    ['fractional keep', { now: NOW, keep: 1.5 }],
  ])('fails closed for %s', async (_label, invalidInput) => {
    const gone = join(home, `invalid-numeric-${String(_label).replaceAll(' ', '-')}`);
    const dir = seedEntry(gone, 999);

    await expect(pruneEphemeralRuntimes(invalidInput)).resolves.toEqual({
      scanned: 0,
      removedOrphaned: 0,
      removedStale: 0,
      removedOverflow: 0,
      skippedActive: 0,
      skippedChanged: 0,
    });
    expect(existsSync(dir)).toBe(true);
  });

  it('bounds the cache by keep, dropping the oldest survivors first', async () => {
    const projects = Array.from({ length: 4 }, () => mkdtempSync(join(tmpdir(), 'opensip-p-')));
    const dirs = projects.map((project, index) => seedEntry(project, index));

    const result = await pruneEphemeralRuntimes({ now: NOW, keep: 2 });

    expect(result.removedOverflow).toBe(2);
    // Index 0/1 are the most recently used; 2/3 are the oldest and go first.
    expect(existsSync(String(dirs[0]))).toBe(true);
    expect(existsSync(String(dirs[1]))).toBe(true);
    expect(existsSync(String(dirs[2]))).toBe(false);
    expect(existsSync(String(dirs[3]))).toBe(false);
    for (const project of projects) rmSync(project, { recursive: true, force: true });
  });

  it('breaks equal-age overflow ties by stable cache key', async () => {
    const projects = Array.from({ length: 3 }, () => mkdtempSync(join(tmpdir(), 'opensip-tie-')));
    const dirs = projects.map((project) => seedEntry(project, 1));
    const keys = dirs.map((dir) => basename(dir));
    keys.sort();
    const oldestKey = keys[0];

    const result = await pruneEphemeralRuntimes({ now: NOW, keep: 2 });

    expect(result.removedOverflow).toBe(1);
    for (const dir of dirs) {
      expect(existsSync(dir)).toBe(basename(dir) !== oldestKey);
    }
    for (const project of projects) rmSync(project, { recursive: true, force: true });
  });

  it('preserves marker-less entries rather than inferring deletion authority', async () => {
    const project = mkdtempSync(join(tmpdir(), 'opensip-legacy-'));
    const dir = seedEntry(project, 0, { marker: false });

    const result = await pruneEphemeralRuntimes({ now: NOW, maxAgeDays: 30 });

    // No identity proof means neither age nor overflow may authorize deletion.
    expect(result.removedOrphaned).toBe(0);
    expect(result.skippedChanged).toBe(1);
    expect(existsSync(dir)).toBe(true);
    rmSync(project, { recursive: true, force: true });
  });

  it.runIf(platform() !== 'win32')(
    'preserves an inaccessible looping project path instead of inferring orphanhood',
    async () => {
      const project = mkdtempSync(join(tmpdir(), 'opensip-looping-project-'));
      const dir = seedEntry(project, 999);
      rmSync(project, { recursive: true });
      symlinkSync(project, project);
      try {
        const result = await pruneEphemeralRuntimes({ now: NOW, maxAgeDays: 30 });
        expect(result).toMatchObject({
          removedOrphaned: 0,
          removedStale: 0,
          skippedChanged: 1,
        });
        expect(existsSync(dir)).toBe(true);
      } finally {
        rmSync(project, { force: true });
      }
    },
  );

  it('fails closed when the bounded cache-root scan overflows', async () => {
    const gone = join(home, 'bounded-scan-project');
    const dir = seedEntry(gone, 999);
    const root = resolveUserPaths().ephemeralProjectsDir;
    for (let index = 0; index < 1025; index += 1) {
      mkdirSync(join(root, `overflow-${index.toString().padStart(4, '0')}`));
    }

    await expect(pruneEphemeralRuntimes({ now: NOW })).resolves.toEqual({
      scanned: 0,
      removedOrphaned: 0,
      removedStale: 0,
      removedOverflow: 0,
      skippedActive: 0,
      skippedChanged: 0,
    });
    expect(existsSync(dir)).toBe(true);
  });

  it('cleans a proven-empty stale coordination scaffold during active-key enumeration', async () => {
    const project = mkdtempSync(join(tmpdir(), 'opensip-empty-coordination-'));
    const coordinationKey = projectCoordinationKey(project);
    const lease = await acquireRuntimeReadLease({
      projectDir: project,
      policy: { waitMs: 100, staleMs: 300, heartbeatMs: 50, pollMs: 2 },
    });
    lease.release();
    const projectPaths = resolveCoordinationPaths().forProject(coordinationKey);
    const projectCoordinationDir = projectPaths.projectCoordinationDir;
    mkdirSync(projectPaths.readersDir, { recursive: true, mode: 0o700 });
    expect(existsSync(projectCoordinationDir)).toBe(true);

    await expect(
      listActiveRuntimeLeaseKeys({
        policy: { waitMs: 100, staleMs: 300, heartbeatMs: 50, pollMs: 2 },
      }),
    ).resolves.toEqual([]);
    expect(existsSync(projectCoordinationDir)).toBe(false);
    rmSync(project, { recursive: true, force: true });
  });

  it('tolerates a missing cache directory', async () => {
    await expect(pruneEphemeralRuntimes({ now: NOW })).resolves.toEqual({
      scanned: 0,
      removedOrphaned: 0,
      removedStale: 0,
      removedOverflow: 0,
      skippedActive: 0,
      skippedChanged: 0,
    });
  });

  it('throttles to once per day', () => {
    expect(shouldPruneEphemeralRuntimes(NOW)).toBe(true);
    expect(shouldPruneEphemeralRuntimes(NOW + 60_000)).toBe(false);
    expect(shouldPruneEphemeralRuntimes(NOW + 2 * DAY_MS)).toBe(true);
  });

  it('serializes concurrent prune-stamp writers and grants one prune pass', async () => {
    const worker = String.raw`
      import { pathToFileURL } from "node:url";
      const core = await import(pathToFileURL(process.argv[1]).href);
      process.stdout.write("READY\n");
      process.stdin.once("data", () => {
        const result = core.shouldPruneEphemeralRuntimes(Number(process.argv[2]));
        process.stdout.write("RESULT:" + String(result) + "\n");
        process.exit(0);
      });
    `;
    const children = Array.from({ length: 2 }, () =>
      spawn(process.execPath, [
        '--input-type=module',
        '--eval',
        worker,
        coreEntryPath(),
        String(NOW),
      ]),
    );
    try {
      await Promise.all(children.map((child) => waitForChildOutput(child, 'READY\n')));
      const results = children.map((child) => waitForChildOutput(child, 'RESULT:'));
      for (const child of children) child.stdin.write('GO\n');
      const outputs = await Promise.all(results);
      outputs.sort();
      expect(outputs).toEqual(['RESULT:false\n', 'RESULT:true\n']);
    } finally {
      for (const child of children) {
        if (child.exitCode === null) child.kill();
      }
    }
  });

  it('does not replace a malformed prune stamp or grant deletion authority', () => {
    const root = resolveUserPaths().ephemeralProjectsDir;
    mkdirSync(root, { recursive: true });
    const stampPath = join(root, '.last-prune');
    writeFileSync(stampPath, 'not-a-timestamp');

    expect(shouldPruneEphemeralRuntimes(NOW)).toBe(false);
    expect(readFileSync(stampPath, 'utf8')).toBe('not-a-timestamp');
  });

  it('preserves a concurrently replaced prune stamp when stamp CAS loses', () => {
    expect(shouldPruneEphemeralRuntimes(NOW)).toBe(true);
    const stampPath = join(resolveUserPaths().ephemeralProjectsDir, '.last-prune');
    const replacement = new Date(NOW + 3 * DAY_MS).toISOString();
    const onEvent = Object.assign((_event: FileLockEvent): void => undefined, {
      [EPHEMERAL_RUNTIME_TEST_HOOKS]: {
        beforePruneStampPublish: () => writeFileSync(stampPath, replacement),
      } satisfies EphemeralRuntimeTestHooks,
    });

    expect(shouldPruneEphemeralRuntimes(NOW + 2 * DAY_MS, onEvent)).toBe(false);
    expect(readFileSync(stampPath, 'utf8')).toBe(replacement);
  });

  it('fails stamp publication closed and releases its metadata lock', () => {
    const root = resolveUserPaths().ephemeralProjectsDir;
    const onEvent = Object.assign((_event: FileLockEvent): void => undefined, {
      [EPHEMERAL_RUNTIME_TEST_HOOKS]: {
        beforePruneStampPublish: () => {
          throw new Error('injected stamp publication failure');
        },
      } satisfies EphemeralRuntimeTestHooks,
    });

    expect(shouldPruneEphemeralRuntimes(NOW, onEvent)).toBe(false);
    expect(existsSync(join(root, '.last-prune'))).toBe(false);
    expect(existsSync(join(root, '.last-prune.lock'))).toBe(false);
  });

  it('exposes a sane default retention bound', () => {
    expect(DEFAULT_EPHEMERAL_KEEP).toBeGreaterThan(0);
  });
});
