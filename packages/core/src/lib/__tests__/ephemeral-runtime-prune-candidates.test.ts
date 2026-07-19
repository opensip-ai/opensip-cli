import { lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveGenerationDigest } from '../ephemeral-project-generation.js';
import { ensureEphemeralRuntimeDirectory } from '../ephemeral-runtime-directory.js';
import {
  EPHEMERAL_MARKER_FILE,
  isValidEphemeralTimestamp,
  parseEphemeralMarker,
  readEphemeralMarker,
} from '../ephemeral-runtime-marker.js';
import {
  compareCandidatesByAge,
  inspectPruneCandidate,
  listPruneEntries,
  remainingBudget,
  removeRevalidatedCandidate,
  revalidateOverflowCandidate,
  sameCandidateSnapshot,
  type PruneCandidate,
} from '../ephemeral-runtime-prune-candidates.js';
import { resolveProtectedCoordinationKeys } from '../ephemeral-runtime-prune-protection.js';
import { projectCoordinationKey, resolveEphemeralProjectPaths } from '../paths.js';

const NOW = Date.parse('2026-07-19T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

let testDir: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'opensip-prune-candidates-'));
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

function seedLegacyEntry(projectDir: string, lastUsedAt: number): string {
  const key = projectCoordinationKey(projectDir);
  const entryDir = join(testDir, key);
  mkdirSync(entryDir, { mode: 0o700 });
  writeFileSync(
    join(entryDir, EPHEMERAL_MARKER_FILE),
    JSON.stringify({
      projectDir,
      lastUsedAt: new Date(lastUsedAt).toISOString(),
    }),
    { mode: 0o600 },
  );
  return key;
}

function candidateForDirectory(
  entryDir: string,
  overrides: Partial<PruneCandidate> = {},
): PruneCandidate {
  const stat = lstatSync(entryDir, { bigint: true });
  return {
    key: 'a'.repeat(24),
    entryDir,
    projectDir: join(testDir, 'project'),
    coordinationKey: 'b'.repeat(24),
    usedAt: NOW,
    markerSha256: 'marker',
    directoryIdentity: {
      dev: stat.dev,
      ino: stat.ino,
      mtimeNs: stat.mtimeNs,
      ctimeNs: stat.ctimeNs,
    },
    verdict: 'keep',
    ...overrides,
  };
}

describe('ephemeral prune candidate helpers', () => {
  it('rejects weak project-generation facts and malformed marker projections', async () => {
    const regularFile = join(testDir, 'not-a-project');
    writeFileSync(regularFile, 'content');
    expect(resolveGenerationDigest(regularFile)).toBeUndefined();

    const projectDir = join(testDir, 'project');
    mkdirSync(projectDir);
    writeFileSync(join(projectDir, '.git'), 'not a gitfile');
    expect(resolveGenerationDigest(projectDir)).toBeUndefined();

    const gitTarget = join(testDir, 'git-target-file');
    writeFileSync(gitTarget, 'not a directory');
    writeFileSync(join(projectDir, '.git'), `gitdir: ${gitTarget}`);
    expect(resolveGenerationDigest(projectDir)).toBeUndefined();

    expect(isValidEphemeralTimestamp(123)).toBe(false);
    expect(parseEphemeralMarker(JSON.stringify({ projectDir }))).toEqual({
      status: 'invalid',
      reason: 'malformed',
    });
    const nonDirectoryEntry = join(testDir, 'not-an-entry');
    writeFileSync(nonDirectoryEntry, 'content');
    expect(readEphemeralMarker(nonDirectoryEntry)).toEqual({
      status: 'invalid',
      reason: 'unreadable',
    });

    await expect(
      resolveProtectedCoordinationKeys([], {
        expiresAt: 0,
        monotonicNow: () => 1,
      }),
    ).resolves.toBeUndefined();
  });

  it('rejects an ephemeral directory whose cache key and runtime path disagree', () => {
    const priorHome = process.env.HOME;
    const isolatedHome = join(testDir, 'home');
    mkdirSync(isolatedHome, { mode: 0o700 });
    process.env.HOME = isolatedHome;
    try {
      const projectDir = join(testDir, 'directory-project');
      mkdirSync(projectDir);
      const paths = resolveEphemeralProjectPaths(projectDir);

      expect(() =>
        ensureEphemeralRuntimeDirectory({
          ...paths,
          cacheKey: 'not-a-cache-key',
        }),
      ).toThrow('Ephemeral runtime path does not match its cache identity');
    } finally {
      if (priorHome === undefined) delete process.env.HOME;
      else process.env.HOME = priorHome;
    }
  });

  it('clamps the monotonic deadline to the requested cap', () => {
    expect(
      remainingBudget(
        {
          expiresAt: 150,
          monotonicNow: () => 100,
        },
        20,
      ),
    ).toBe(20);
    expect(
      remainingBudget(
        {
          expiresAt: 105.9,
          monotonicNow: () => 100,
        },
        20,
      ),
    ).toBe(5);
    expect(
      remainingBudget(
        {
          expiresAt: 90,
          monotonicNow: () => 100,
        },
        20,
      ),
    ).toBe(0);
  });

  it('returns a complete directory-only view and distinguishes missing from unreadable roots', () => {
    mkdirSync(join(testDir, 'directory'));
    writeFileSync(join(testDir, 'file'), 'not a directory');

    expect(listPruneEntries(testDir)).toEqual(['directory']);
    expect(listPruneEntries(join(testDir, 'missing'))).toEqual([]);
    expect(listPruneEntries(join(testDir, 'file'))).toBeUndefined();
  });

  it('fails a cache-root scan closed when its hard entry cap is exceeded', () => {
    for (let index = 0; index < 1025; index += 1) {
      mkdirSync(join(testDir, `entry-${index.toString().padStart(4, '0')}`));
    }

    expect(listPruneEntries(testDir)).toBeUndefined();
  });

  it('classifies proven legacy entries without granting authority to malformed paths', () => {
    const existingProject = mkdtempSync(join(tmpdir(), 'opensip-prune-project-'));
    const staleKey = seedLegacyEntry(existingProject, NOW - 90 * DAY_MS);
    const orphanProject = join(testDir, 'deleted-project');
    const orphanKey = seedLegacyEntry(orphanProject, NOW - DAY_MS);
    mkdirSync(join(testDir, 'not-a-cache-key'));

    try {
      expect(inspectPruneCandidate(testDir, 'not-a-cache-key', NOW, 30 * DAY_MS)).toBeUndefined();
      expect(inspectPruneCandidate(testDir, staleKey, NOW, 30 * DAY_MS)).toMatchObject({
        key: staleKey,
        projectDir: existingProject,
        verdict: 'stale',
      });
      expect(inspectPruneCandidate(testDir, orphanKey, NOW, 30 * DAY_MS)).toMatchObject({
        key: orphanKey,
        projectDir: orphanProject,
        verdict: 'orphaned',
      });
    } finally {
      rmSync(existingProject, { recursive: true, force: true });
    }
  });

  it('fails closed for unprovable cache-entry paths, markers, and identities', () => {
    const regularFileKey = 'f'.repeat(24);
    writeFileSync(join(testDir, regularFileKey), 'not a directory');
    expect(inspectPruneCandidate(testDir, regularFileKey, NOW, 30 * DAY_MS)).toBeUndefined();

    const missingKey = 'e'.repeat(24);
    expect(inspectPruneCandidate(testDir, missingKey, NOW, 30 * DAY_MS)).toBeUndefined();

    const malformedKey = 'd'.repeat(24);
    const malformedDir = join(testDir, malformedKey);
    mkdirSync(malformedDir);
    writeFileSync(join(malformedDir, EPHEMERAL_MARKER_FILE), '{not-json');
    expect(inspectPruneCandidate(testDir, malformedKey, NOW, 30 * DAY_MS)).toBeUndefined();

    const wrongIdentityKey = 'c'.repeat(24);
    const wrongIdentityDir = join(testDir, wrongIdentityKey);
    const projectDir = join(testDir, 'identity-project');
    mkdirSync(wrongIdentityDir);
    mkdirSync(projectDir);
    writeFileSync(
      join(wrongIdentityDir, EPHEMERAL_MARKER_FILE),
      JSON.stringify({
        projectDir,
        lastUsedAt: new Date(NOW).toISOString(),
      }),
    );
    expect(inspectPruneCandidate(testDir, wrongIdentityKey, NOW, 30 * DAY_MS)).toBeUndefined();
  });

  it('compares every snapshot identity field and breaks equal-age ties by key', () => {
    const entryDir = join(testDir, 'candidate');
    mkdirSync(entryDir);
    const base = candidateForDirectory(entryDir);

    expect(sameCandidateSnapshot(base, { ...base })).toBe(true);
    for (const changed of [
      { key: 'c'.repeat(24) },
      { projectDir: join(testDir, 'other-project') },
      { coordinationKey: 'd'.repeat(24) },
      { usedAt: NOW + 1 },
      { markerSha256: 'other-marker' },
      {
        directoryIdentity: {
          ...base.directoryIdentity,
          dev: base.directoryIdentity.dev + 1n,
        },
      },
      {
        directoryIdentity: {
          ...base.directoryIdentity,
          ino: base.directoryIdentity.ino + 1n,
        },
      },
      {
        directoryIdentity: {
          ...base.directoryIdentity,
          mtimeNs: base.directoryIdentity.mtimeNs + 1n,
        },
      },
      {
        directoryIdentity: {
          ...base.directoryIdentity,
          ctimeNs: base.directoryIdentity.ctimeNs + 1n,
        },
      },
    ] satisfies readonly Partial<PruneCandidate>[]) {
      expect(sameCandidateSnapshot(base, { ...base, ...changed })).toBe(false);
    }

    expect(compareCandidatesByAge(base, { ...base, usedAt: NOW + 1 })).toBeLessThan(0);
    expect(
      compareCandidatesByAge({ ...base, key: 'a'.repeat(24) }, { ...base, key: 'b'.repeat(24) }),
    ).toBeLessThan(0);
  });

  it('revalidates an oldest overflow candidate against a complete current view', () => {
    const oldProject = mkdtempSync(join(tmpdir(), 'opensip-prune-old-'));
    const newProject = mkdtempSync(join(tmpdir(), 'opensip-prune-new-'));
    const oldKey = seedLegacyEntry(oldProject, NOW - 2 * DAY_MS);
    const newKey = seedLegacyEntry(newProject, NOW - DAY_MS);

    try {
      const oldCandidate = inspectPruneCandidate(testDir, oldKey, NOW, 30 * DAY_MS);
      expect(oldCandidate).toBeDefined();
      expect(
        revalidateOverflowCandidate(testDir, oldCandidate!, 1, NOW, 30 * DAY_MS, {
          expiresAt: 100,
          monotonicNow: () => 0,
        }),
      ).toMatchObject({ key: oldKey });
      const newCandidate = inspectPruneCandidate(testDir, newKey, NOW, 30 * DAY_MS);
      expect(newCandidate).toBeDefined();
      expect(
        revalidateOverflowCandidate(testDir, newCandidate!, 1, NOW, 30 * DAY_MS, {
          expiresAt: 100,
          monotonicNow: () => 0,
        }),
      ).toBeUndefined();
      expect(
        revalidateOverflowCandidate(
          testDir,
          { ...oldCandidate!, markerSha256: 'changed' },
          1,
          NOW,
          30 * DAY_MS,
          {
            expiresAt: 100,
            monotonicNow: () => 0,
          },
        ),
      ).toBeUndefined();
      expect(
        revalidateOverflowCandidate(testDir, oldCandidate!, 2, NOW, 30 * DAY_MS, {
          expiresAt: 100,
          monotonicNow: () => 0,
        }),
      ).toBeUndefined();
      expect(
        revalidateOverflowCandidate(testDir, oldCandidate!, 1, NOW, 30 * DAY_MS, {
          expiresAt: 0,
          monotonicNow: () => 1,
        }),
      ).toBeUndefined();
      writeFileSync(join(testDir, newKey, EPHEMERAL_MARKER_FILE), '{not-json');
      expect(
        revalidateOverflowCandidate(testDir, oldCandidate!, 1, NOW, 30 * DAY_MS, {
          expiresAt: 100,
          monotonicNow: () => 0,
        }),
      ).toBeUndefined();
    } finally {
      rmSync(oldProject, { recursive: true, force: true });
      rmSync(newProject, { recursive: true, force: true });
    }
  });

  it('removes only the directory represented by the revalidated identity', () => {
    const removableDir = join(testDir, 'removable');
    mkdirSync(removableDir);
    const removable = candidateForDirectory(removableDir);
    expect(removeRevalidatedCandidate(removable)).toBe(true);
    expect(removeRevalidatedCandidate(removable)).toBe(false);

    const changedDir = join(testDir, 'changed');
    mkdirSync(changedDir);
    const changed = candidateForDirectory(changedDir);
    expect(
      removeRevalidatedCandidate({
        ...changed,
        directoryIdentity: {
          ...changed.directoryIdentity,
          ino: changed.directoryIdentity.ino + 1n,
        },
      }),
    ).toBe(false);
  });
});
