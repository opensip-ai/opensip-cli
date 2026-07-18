import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  EPHEMERAL_MARKER_FILE,
  projectCoordinationKey,
  resolveUserPaths,
  type RuntimeExclusiveLease,
} from '@opensip-cli/core';
import { DataStoreFactory, type SqliteIntegrityResult } from '@opensip-cli/datastore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { inspectRuntimeTree } from '../runtime-manifest-io.js';
import {
  assertRuntimeStageOwnershipMarker,
  compareRuntimeManifests,
  copyRuntimeToStage,
  encodeRuntimeStageOwnershipMarker,
  inspectVerifiedRuntimeManifest,
  RUNTIME_MANIFEST_DIFF_SAMPLE_LIMIT,
  RUNTIME_MANIFEST_MAX_DIGEST_BYTES,
  RUNTIME_MANIFEST_MAX_ENTRIES,
  RUNTIME_MANIFEST_MAX_FILE_BYTES,
  RUNTIME_MANIFEST_MAX_PATH_AGGREGATE_BYTES,
  RUNTIME_MANIFEST_MAX_PATH_BYTES,
  RUNTIME_MANIFEST_MAX_TOTAL_BYTES,
  RuntimeManifestError,
  RUNTIME_STAGE_OWNERSHIP_FILE,
  runtimeManifestIdentityEqual,
} from '../runtime-manifest.js';
import { createRuntimePromotionOwnedSlots } from '../runtime-promotion-journal-schema.js';
import { captureRuntimePromotionProjectRootAuthority } from '../runtime-promotion-root-authority.js';
import { materializeRuntimeStage, type RuntimeStageIoCheckpoint } from '../runtime-stage-io.js';
import { createRuntimeStageOwnershipMarker } from '../runtime-stage-ownership.js';

import type { RuntimeManifestEntry, RuntimeTreeManifest } from '../runtime-manifest-model.js';
import type {
  CopyRuntimeToStageInput,
  RuntimeManifestCheckpoint,
  RuntimeManifestDependencies,
  RuntimeManifestIdentity,
  VerifiedRuntimeManifest,
} from '../runtime-manifest.js';
import type { RuntimePromotionJournal } from '../runtime-promotion-journal-schema.js';
import type {
  DurableOpenPromotionJournal,
  RuntimePromotionJournalController,
  RuntimeStageMaterializationAuthority,
  RuntimeStageMaterializationIdentity,
} from '../runtime-promotion-journal.js';

let temporaryDirectory: string;
let originalHome: string | undefined;
const ABSENT_SQLITE_IDENTITY = { status: 'absent' } as const;
const SOURCE_CACHE_KEY = 'a'.repeat(24);
const STAGE_OPERATION_ID = 'runtime-manifest-stage-operation-0001';
const STAGE_SLOT = createRuntimePromotionOwnedSlots(STAGE_OPERATION_ID).runtimeStage;
const STAGE_BASENAME = STAGE_SLOT.basename;
const STAGE_OWNERSHIP: RuntimeStageMaterializationIdentity = Object.freeze({
  operationId: STAGE_OPERATION_ID,
  stageBasename: STAGE_BASENAME,
  ownershipId: STAGE_SLOT.ownershipId,
});
const FOREIGN_STAGE_OPERATION_ID = 'runtime-manifest-foreign-stage-operation';
const FOREIGN_STAGE_SLOT = createRuntimePromotionOwnedSlots(
  FOREIGN_STAGE_OPERATION_ID,
).runtimeStage;
const FOREIGN_STAGE_OWNERSHIP: RuntimeStageMaterializationIdentity = Object.freeze({
  operationId: FOREIGN_STAGE_OPERATION_ID,
  stageBasename: FOREIGN_STAGE_SLOT.basename,
  ownershipId: FOREIGN_STAGE_SLOT.ownershipId,
});

beforeEach(() => {
  temporaryDirectory = mkdtempSync(join(tmpdir(), 'runtime-manifest-'));
  chmodSync(temporaryDirectory, 0o700);
  originalHome = process.env.HOME;
  process.env.HOME = realpathSync(temporaryDirectory);
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

function makeDirectory(path: string, mode = 0o700): string {
  mkdirSync(path, { recursive: true, mode });
  chmodSync(path, mode);
  return path;
}

function writeRuntimeFile(root: string, relativePath: string, content: string): string {
  const path = join(root, ...relativePath.split('/'));
  makeDirectory(dirname(path));
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

function makeRuntime(name: string): string {
  return makeDirectory(join(temporaryDirectory, name));
}

function makeCopyDestinationParent(name: string): string {
  return makeDirectory(join(makeRuntime(`${name}-project`), 'opensip-cli'));
}

function makeCopySource(): string {
  return realpathSync(
    makeDirectory(join(resolveUserPaths().ephemeralProjectsDir, SOURCE_CACHE_KEY)),
  );
}

function createValidDatastore(runtime: string): string {
  const path = join(runtime, 'datastore.sqlite');
  const datastore = DataStoreFactory.open({ backend: 'sqlite', path });
  const result = datastore.closeForLifecycle?.();
  if (result !== undefined && !result.closed) {
    throw new Error('test datastore did not close');
  }
  if (result === undefined) datastore.close();
  return path;
}

function absentSqliteResult(): SqliteIntegrityResult {
  return {
    status: 'absent',
    reason: 'file-absent',
    sidecars: {
      before: { wal: 'absent', shm: 'absent' },
      after: { wal: 'absent', shm: 'absent' },
    },
  };
}

function nativeCloseFailedSqliteResult(): SqliteIntegrityResult {
  return {
    status: 'unreadable',
    reason: 'native-close-failed',
    sidecars: {
      before: { wal: 'absent', shm: 'absent' },
      after: { wal: 'absent', shm: 'absent' },
    },
  };
}

function manifestEntry(
  path: string,
  sha256 = 'a'.repeat(64),
): Extract<RuntimeManifestEntry, { kind: 'file' }> {
  return {
    path,
    kind: 'file',
    mode: 0o600,
    sizeBytes: 1,
    sha256,
  };
}

function treeManifest(
  entries: readonly RuntimeManifestEntry[],
  sha256 = 'b'.repeat(64),
): RuntimeTreeManifest {
  return {
    version: 1,
    rootMode: 0o700,
    sha256,
    entryCount: entries.length,
    fileCount: entries.filter((entry) => entry.kind === 'file').length,
    directoryCount: entries.filter((entry) => entry.kind === 'directory').length,
    symlinkCount: entries.filter((entry) => entry.kind === 'symlink').length,
    totalBytes: entries.reduce(
      (total, entry) => total + (entry.kind === 'file' ? entry.sizeBytes : 0),
      0,
    ),
    entries,
  };
}

function runtimeIdentity(
  tree: RuntimeTreeManifest,
  sqlite: RuntimeManifestIdentity['sqlite'] = ABSENT_SQLITE_IDENTITY,
): RuntimeManifestIdentity {
  return {
    digest: tree.sha256,
    rootMode: tree.rootMode,
    fileCount: tree.fileCount,
    directoryCount: tree.directoryCount,
    symlinkCount: tree.symlinkCount,
    totalBytes: tree.totalBytes,
    sqlite,
  };
}

function verifiedManifest(
  entries: readonly RuntimeManifestEntry[],
  sha256 = 'b'.repeat(64),
  sqlite: RuntimeManifestIdentity['sqlite'] = ABSENT_SQLITE_IDENTITY,
): VerifiedRuntimeManifest {
  const tree = treeManifest(entries, sha256);
  return { identity: runtimeIdentity(tree, sqlite), entries };
}

function expectManifestFailure(
  action: () => unknown,
  reason: RuntimeManifestError['reason'],
): void {
  try {
    action();
    throw new Error('expected runtime manifest inspection to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(RuntimeManifestError);
    expect((error as RuntimeManifestError).reason).toBe(reason);
  }
}

function expectReleaseUnsafeManifestFailure(
  action: () => unknown,
  reason: RuntimeManifestError['reason'],
): RuntimeManifestError {
  try {
    action();
    throw new Error('expected release-unsafe runtime manifest inspection to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(RuntimeManifestError);
    expect((error as RuntimeManifestError).reason).toBe(reason);
    expect((error as RuntimeManifestError).releaseSafe).toBe(false);
    return error as RuntimeManifestError;
  }
}

interface AuthorityHarness {
  readonly controller: RuntimePromotionJournalController;
  readonly receipt: DurableOpenPromotionJournal;
  readonly events: string[];
  readonly verifyOpen: ReturnType<typeof vi.fn>;
  readonly assertBoundLease: ReturnType<typeof vi.fn>;
  readonly authorize: ReturnType<typeof vi.fn>;
  readonly assertAuthority: ReturnType<typeof vi.fn>;
}

function authorityHarness(
  options: {
    readonly rejectAuthorization?: Error;
    readonly rejectLease?: Error;
    readonly sourceManifest?: RuntimeManifestIdentity;
  } = {},
): AuthorityHarness {
  const events: string[] = [];
  const issued = new WeakSet<object>();
  const verifyOpen = vi.fn((): Promise<RuntimePromotionJournal> => {
    const sourceDir = realpathSync(join(resolveUserPaths().ephemeralProjectsDir, SOURCE_CACHE_KEY));
    return Promise.resolve({
      route: 'promote-cache',
      source: {
        classification: 'path-only',
        cacheKey: SOURCE_CACHE_KEY,
        generationDigest: null,
        markerSha256: 'b'.repeat(64),
      },
      manifests: {
        source:
          options.sourceManifest ??
          inspectVerifiedRuntimeManifest(sourceDir, 'cache-source').identity,
        destination: null,
        runtimeStage: null,
      },
    } as RuntimePromotionJournal);
  });
  const assertBoundLease = vi.fn(() => {
    if (options.rejectLease !== undefined) throw options.rejectLease;
  });
  const authorize = vi.fn(
    (
      _receipt: DurableOpenPromotionJournal,
      stageBasename: string,
    ): Promise<RuntimeStageMaterializationAuthority> => {
      events.push('authorize');
      if (options.rejectAuthorization !== undefined) throw options.rejectAuthorization;
      const authority = Object.freeze({
        coordinationKey: 'k1:test',
        operationId: STAGE_OPERATION_ID,
        revision: 1,
        stageBasename,
        ownershipId: STAGE_SLOT.ownershipId,
      }) as RuntimeStageMaterializationAuthority;
      issued.add(authority);
      return Promise.resolve(authority);
    },
  );
  const assertAuthority = vi.fn(
    (
      authority: RuntimeStageMaterializationAuthority,
      stageBasename: string,
    ): RuntimeStageMaterializationIdentity => {
      events.push('consume-authority');
      if (
        !issued.delete(authority) ||
        authority.stageBasename !== stageBasename ||
        stageBasename !== STAGE_BASENAME ||
        authority.ownershipId !== STAGE_SLOT.ownershipId
      ) {
        throw new Error('stale stage authority');
      }
      return STAGE_OWNERSHIP;
    },
  );
  const controller = {
    assertBoundLease,
    verifyOpen,
    authorizeRuntimeStage: authorize,
    assertRuntimeStageAuthority: assertAuthority,
  } as unknown as RuntimePromotionJournalController;
  const receipt = Object.freeze({
    state: 'open',
  }) as DurableOpenPromotionJournal;
  return {
    controller,
    receipt,
    events,
    verifyOpen,
    assertBoundLease,
    authorize,
    assertAuthority,
  };
}

function copyInput(
  sourceDir: string,
  destinationParent: string,
  harness: AuthorityHarness,
  stageBasename = STAGE_BASENAME,
): CopyRuntimeToStageInput {
  const canonicalDestinationParent = realpathSync(destinationParent);
  const projectRoot = dirname(canonicalDestinationParent);
  const authority = copyRootAuthority(projectRoot);
  return {
    controller: harness.controller,
    receipt: harness.receipt,
    sourceDir,
    sourcePosture: 'cache-source',
    destinationParent: canonicalDestinationParent,
    stageBasename,
    ...authority,
  };
}

function copyRootAuthority(
  projectRoot: string,
): Pick<CopyRuntimeToStageInput, 'lease' | 'projectRootAuthority'> {
  const lease = {
    kind: 'runtime-exclusive',
    coordinationKey: projectCoordinationKey(projectRoot),
    posture: 'normal',
    ownerToken: 'runtime-manifest-root-owner-0001',
    acquiredAt: 1,
    release: () => undefined,
  } satisfies RuntimeExclusiveLease;
  return {
    projectRootAuthority: captureRuntimePromotionProjectRootAuthority({
      lease,
      projectRoot,
      expectedPosture: 'normal',
    }),
    lease,
  };
}

describe('runtime manifest inspection', () => {
  it('produces the same deterministic identity for equivalent nested trees', () => {
    const left = makeRuntime('left');
    const right = makeRuntime('right');

    writeRuntimeFile(left, 'z-last.txt', 'last');
    writeRuntimeFile(left, 'nested/deep/value.txt', 'value');
    writeRuntimeFile(left, 'a-first.txt', 'first');

    writeRuntimeFile(right, 'a-first.txt', 'first');
    writeRuntimeFile(right, 'nested/deep/value.txt', 'value');
    writeRuntimeFile(right, 'z-last.txt', 'last');

    const leftManifest = inspectVerifiedRuntimeManifest(left, 'project-runtime');
    const rightManifest = inspectVerifiedRuntimeManifest(right, 'project-runtime');

    expect(leftManifest.entries.map((entry) => entry.path)).toEqual([
      'a-first.txt',
      'nested',
      'nested/deep',
      'nested/deep/value.txt',
      'z-last.txt',
    ]);
    expect(rightManifest).toEqual(leftManifest);
    expect(runtimeManifestIdentityEqual(leftManifest.identity, rightManifest.identity)).toBe(true);
    expect(compareRuntimeManifests(leftManifest, rightManifest)).toEqual({
      equal: true,
      onlyLeft: 0,
      onlyRight: 0,
      changed: 0,
      truncated: false,
      samples: [],
    });
  });

  it('walks non-ASCII relative paths in UTF-8 byte order rather than UTF-16 order', () => {
    const runtime = makeRuntime('unicode-order');
    const privateUse = '\u{E000}.txt';
    const supplementary = '\u{10000}.txt';
    writeRuntimeFile(runtime, supplementary, 'supplementary');
    writeRuntimeFile(runtime, privateUse, 'private');

    expect(
      inspectVerifiedRuntimeManifest(runtime, 'project-runtime').entries.map((entry) => entry.path),
    ).toEqual([privateUse, supplementary]);
  });

  it('omits only the cache marker and recognized operation-owned lock files', () => {
    const runtime = makeRuntime('cache-omissions');
    writeRuntimeFile(runtime, EPHEMERAL_MARKER_FILE, '{"kind":"ephemeral-project"}');
    writeRuntimeFile(runtime, '.project-marker.lock', '');
    writeRuntimeFile(runtime, 'datastore.sqlite.write.lock', '');
    writeRuntimeFile(runtime, 'artifacts/one.artifact.lock', '');
    writeRuntimeFile(runtime, 'artifacts/kept.lock', 'customer data');
    writeRuntimeFile(runtime, 'kept.txt', 'evidence');

    const cache = inspectVerifiedRuntimeManifest(runtime, 'cache-source');
    expect(cache.entries.map((entry) => entry.path)).toEqual([
      'artifacts',
      'artifacts/kept.lock',
      'kept.txt',
    ]);

    const project = inspectVerifiedRuntimeManifest(runtime, 'project-runtime');
    expect(project.entries.map((entry) => entry.path)).toContain(EPHEMERAL_MARKER_FILE);
  });

  it('omits empty SQLite sidecars beside a valid, closed datastore', () => {
    const runtime = makeRuntime('empty-sidecars');
    createValidDatastore(runtime);
    writeRuntimeFile(runtime, 'datastore.sqlite-wal', '');
    writeRuntimeFile(runtime, 'datastore.sqlite-shm', '');

    const manifest = inspectVerifiedRuntimeManifest(runtime, 'cache-source');

    expect(manifest.entries.map((entry) => entry.path)).toContain('datastore.sqlite');
    expect(manifest.entries.map((entry) => entry.path)).not.toContain('datastore.sqlite-wal');
    expect(manifest.entries.map((entry) => entry.path)).not.toContain('datastore.sqlite-shm');
    expect(manifest.identity.sqlite).toMatchObject({ status: 'verified' });
  });

  it('rejects a nonempty SQLite sidecar instead of silently omitting bytes', () => {
    const runtime = makeRuntime('nonempty-sidecar');
    createValidDatastore(runtime);
    writeRuntimeFile(runtime, 'datastore.sqlite-wal', 'uncheckpointed bytes');

    expectManifestFailure(
      () => inspectVerifiedRuntimeManifest(runtime, 'cache-source'),
      'sqlite-sidecar-nonempty',
    );
  });

  it('rejects an unbounded SQLite shared-memory sidecar', () => {
    const runtime = makeRuntime('oversize-shm');
    createValidDatastore(runtime);
    writeFileSync(join(runtime, 'datastore.sqlite-shm'), Buffer.alloc(1024 * 1024 + 1), {
      mode: 0o600,
    });

    expectManifestFailure(
      () => inspectVerifiedRuntimeManifest(runtime, 'cache-source'),
      'sqlite-sidecar-nonempty',
    );
  });

  it('accepts a runtime with no datastore only when all SQLite paths are absent', () => {
    const runtime = makeRuntime('no-datastore');
    writeRuntimeFile(runtime, 'report.html', '<p>report</p>');

    expect(inspectVerifiedRuntimeManifest(runtime, 'project-runtime').identity.sqlite).toEqual({
      status: 'absent',
    });

    writeRuntimeFile(runtime, 'datastore.sqlite-wal', '');
    expectManifestFailure(
      () => inspectVerifiedRuntimeManifest(runtime, 'project-runtime'),
      'sqlite-absent-with-sidecar',
    );
  });

  it('rejects hardlinked files', () => {
    const runtime = makeRuntime('hardlinks');
    const original = writeRuntimeFile(runtime, 'original.bin', 'same inode');
    linkSync(original, join(runtime, 'second.bin'));

    expectManifestFailure(
      () => inspectVerifiedRuntimeManifest(runtime, 'project-runtime'),
      'hardlink',
    );
  });

  it('rejects special filesystem entries', () => {
    if (process.platform === 'win32') return;
    const runtime = makeRuntime('special');
    const fifo = join(runtime, 'runtime.fifo');
    const result = spawnSync('mkfifo', [fifo], { encoding: 'utf8' });
    if (result.status !== 0) return;

    expectManifestFailure(
      () => inspectVerifiedRuntimeManifest(runtime, 'project-runtime'),
      'special-entry',
    );
  });

  it('accepts a relative symlink only when its resolved target stays in-tree', () => {
    if (process.platform === 'win32') return;
    const runtime = makeRuntime('safe-symlink');
    writeRuntimeFile(runtime, 'node_modules/tool/bin.js', 'tool');
    makeDirectory(join(runtime, 'node_modules/.bin'));
    symlinkSync('../tool/bin.js', join(runtime, 'node_modules/.bin/tool'));

    const manifest = inspectVerifiedRuntimeManifest(runtime, 'project-runtime');
    const link = manifest.entries.find((entry) => entry.path === 'node_modules/.bin/tool');

    expect(link).toMatchObject({
      kind: 'symlink',
      target: '../tool/bin.js',
    });
    expect(manifest.identity.symlinkCount).toBe(1);
  });

  it.each([
    {
      name: 'absolute',
      target: (runtime: string) => join(runtime, 'target.txt'),
      reason: 'symlink-invalid' as const,
    },
    {
      name: 'escaping',
      target: () => '../outside.txt',
      reason: 'symlink-escape' as const,
    },
    {
      name: 'dangling',
      target: () => 'missing.txt',
      reason: 'symlink-invalid' as const,
    },
  ])('rejects a $name symlink', ({ name, target, reason }) => {
    if (process.platform === 'win32') return;
    const runtime = makeRuntime(`unsafe-link-${name}`);
    writeRuntimeFile(runtime, 'target.txt', 'inside');
    writeRuntimeFile(temporaryDirectory, 'outside.txt', 'outside');
    symlinkSync(target(runtime), join(runtime, 'link'));

    expectManifestFailure(() => inspectVerifiedRuntimeManifest(runtime, 'project-runtime'), reason);
  });

  it('rejects group/world-writable runtime entries on POSIX', () => {
    if (process.platform === 'win32') return;
    const runtime = makeRuntime('unsafe-mode');
    const path = writeRuntimeFile(runtime, 'unsafe.txt', 'unsafe');
    chmodSync(path, 0o666);

    expectManifestFailure(() => inspectVerifiedRuntimeManifest(runtime, 'project-runtime'), 'mode');
  });

  it('rejects an oversized sparse file before attempting digest work', () => {
    const runtime = makeRuntime('oversized-file');
    const path = writeRuntimeFile(runtime, 'oversized.bin', '');
    truncateSync(path, RUNTIME_MANIFEST_MAX_FILE_BYTES + 1);

    expectManifestFailure(
      () => inspectVerifiedRuntimeManifest(runtime, 'project-runtime'),
      'size-cap',
    );
  });

  it('detects a tree changing between its SQLite inspection snapshots', () => {
    const before = treeManifest([manifestEntry('one.txt')], '1'.repeat(64));
    const after = treeManifest([manifestEntry('one.txt', '2'.repeat(64))], '2'.repeat(64));
    let inspection = 0;

    expectManifestFailure(
      () =>
        inspectVerifiedRuntimeManifest('/not-read-by-test', 'project-runtime', {
          inspectTree: () => (inspection++ === 0 ? before : after),
          inspectSqlite: absentSqliteResult,
        }),
      'changed',
    );
  });

  it('exports explicit finite bounds sized for real runtime evidence', () => {
    expect(RUNTIME_MANIFEST_MAX_ENTRIES).toBeGreaterThanOrEqual(100_000);
    expect(RUNTIME_MANIFEST_MAX_PATH_BYTES).toBeGreaterThanOrEqual(4096);
    expect(RUNTIME_MANIFEST_MAX_PATH_AGGREGATE_BYTES).toBeGreaterThan(
      RUNTIME_MANIFEST_MAX_PATH_BYTES,
    );
    expect(RUNTIME_MANIFEST_MAX_FILE_BYTES).toBeGreaterThan(0);
    expect(RUNTIME_MANIFEST_MAX_TOTAL_BYTES).toBeGreaterThanOrEqual(
      RUNTIME_MANIFEST_MAX_FILE_BYTES,
    );
    expect(RUNTIME_MANIFEST_MAX_DIGEST_BYTES).toBeGreaterThanOrEqual(
      RUNTIME_MANIFEST_MAX_TOTAL_BYTES,
    );
    for (const cap of [
      RUNTIME_MANIFEST_MAX_ENTRIES,
      RUNTIME_MANIFEST_MAX_PATH_BYTES,
      RUNTIME_MANIFEST_MAX_PATH_AGGREGATE_BYTES,
      RUNTIME_MANIFEST_MAX_FILE_BYTES,
      RUNTIME_MANIFEST_MAX_TOTAL_BYTES,
      RUNTIME_MANIFEST_MAX_DIGEST_BYTES,
    ]) {
      expect(Number.isSafeInteger(cap)).toBe(true);
    }
  });

  it('caps directory discovery before an oversized name set can enter the queue', () => {
    const runtime = makeRuntime('oversized-directory');

    expectManifestFailure(
      () =>
        inspectRuntimeTree(runtime, 'project-runtime', {
          enumerateDirectoryNames: function* () {
            for (let index = 0; index <= RUNTIME_MANIFEST_MAX_ENTRIES; index += 1) {
              yield `entry-${index}`;
            }
          },
        }),
      'entry-cap',
    );
  });
});

describe('SQLite promotion policy', () => {
  it('records a supported datastore identity from a real closed database', () => {
    const runtime = makeRuntime('valid-sqlite');
    const databasePath = createValidDatastore(runtime);

    const manifest = inspectVerifiedRuntimeManifest(runtime, 'project-runtime');

    expect(manifest.identity.sqlite).toMatchObject({
      status: 'verified',
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      userVersion: expect.any(Number),
    });
    expect(statSync(databasePath).size).toBeGreaterThan(0);
  });

  it('rejects a corrupt or non-SQLite datastore', () => {
    const runtime = makeRuntime('corrupt-sqlite');
    writeRuntimeFile(runtime, 'datastore.sqlite', 'not a SQLite database');

    expectManifestFailure(
      () => inspectVerifiedRuntimeManifest(runtime, 'project-runtime'),
      'sqlite-invalid',
    );
  });

  it('preserves an explicit native-close failure as release-unsafe evidence', () => {
    const tree = treeManifest([manifestEntry('datastore.sqlite')]);

    expectReleaseUnsafeManifestFailure(
      () =>
        inspectVerifiedRuntimeManifest('/not-read-by-test', 'project-runtime', {
          inspectTree: () => tree,
          inspectSqlite: nativeCloseFailedSqliteResult,
        }),
      'sqlite-native-close-failed',
    );
  });

  it('treats an unexpected SQLite inspector throw as unproven close safety', () => {
    const tree = treeManifest([manifestEntry('datastore.sqlite')]);
    const inspectorFailure = new Error('injected inspector failure');

    const error = expectReleaseUnsafeManifestFailure(
      () =>
        inspectVerifiedRuntimeManifest('/not-read-by-test', 'project-runtime', {
          inspectTree: () => tree,
          inspectSqlite: () => {
            throw inspectorFailure;
          },
        }),
      'sqlite-close-unproven',
    );
    expect(error.cause).toBe(inspectorFailure);
  });

  it('keeps ordinary manifest policy failures release-safe', () => {
    const error = new RuntimeManifestError('sqlite-invalid');

    expect(error.releaseSafe).toBe(true);
  });

  it('rejects a valid database written by a newer schema version', () => {
    const tree = treeManifest([manifestEntry('datastore.sqlite')]);

    expectManifestFailure(
      () =>
        inspectVerifiedRuntimeManifest('/not-read-by-test', 'project-runtime', {
          inspectTree: () => tree,
          inspectSqlite: () => ({
            status: 'unsupported',
            reason: 'schema-newer-than-cli',
            sizeBytes: 1,
            sha256: 'a'.repeat(64),
            userVersion: 9999,
            supportedVersion: 1,
            supported: false,
            quickCheck: { ok: true, issueCount: 0, truncated: false },
            foreignKeys: {
              ok: true,
              violationCount: 0,
              sampleCap: 16,
              truncated: false,
              samples: [],
            },
            sidecars: {
              before: { wal: 'absent', shm: 'absent' },
              after: { wal: 'absent', shm: 'absent' },
            },
          }),
        }),
      'sqlite-unsupported',
    );
  });

  it('rejects disagreement between the tree digest and SQLite integrity proof', () => {
    const tree = treeManifest([manifestEntry('datastore.sqlite')]);

    expectManifestFailure(
      () =>
        inspectVerifiedRuntimeManifest('/not-read-by-test', 'project-runtime', {
          inspectTree: () => tree,
          inspectSqlite: () => ({
            status: 'valid',
            sizeBytes: 1,
            sha256: 'f'.repeat(64),
            userVersion: 1,
            supportedVersion: 1,
            supported: true,
            quickCheck: { ok: true, issueCount: 0, truncated: false },
            foreignKeys: {
              ok: true,
              violationCount: 0,
              sampleCap: 16,
              truncated: false,
              samples: [],
            },
            sidecars: {
              before: { wal: 'absent', shm: 'absent' },
              after: { wal: 'absent', shm: 'absent' },
            },
          }),
        }),
      'sqlite-mismatch',
    );
  });
});

describe('manifest identity and bounded differences', () => {
  it('compares every identity field, including the SQLite proof', () => {
    const tree = treeManifest([manifestEntry('one.txt')]);
    const absent = runtimeIdentity(tree);
    const valid = runtimeIdentity(tree, {
      status: 'verified',
      sha256: 'c'.repeat(64),
      userVersion: 1,
    });

    expect(runtimeManifestIdentityEqual(absent, { ...absent })).toBe(true);
    expect(runtimeManifestIdentityEqual(absent, valid)).toBe(false);
    expect(
      runtimeManifestIdentityEqual(valid, {
        ...valid,
        sqlite: { status: 'verified', sha256: 'c'.repeat(64), userVersion: 2 },
      }),
    ).toBe(false);
  });

  it('reports exact counts but caps path samples', () => {
    const commonChanged = Array.from({ length: 8 }, (_, index) =>
      manifestEntry(`changed-${String(index).padStart(2, '0')}.txt`, '1'.repeat(64)),
    );
    const leftOnly = Array.from({ length: 10 }, (_, index) =>
      manifestEntry(`left-${String(index).padStart(2, '0')}.txt`),
    );
    const rightOnly = Array.from({ length: 9 }, (_, index) =>
      manifestEntry(`right-${String(index).padStart(2, '0')}.txt`),
    );
    const left = verifiedManifest([...commonChanged, ...leftOnly], '1'.repeat(64));
    const right = verifiedManifest(
      [...commonChanged.map((entry) => ({ ...entry, sha256: '2'.repeat(64) })), ...rightOnly],
      '2'.repeat(64),
    );

    const difference = compareRuntimeManifests(left, right);

    expect(difference).toMatchObject({
      equal: false,
      onlyLeft: 10,
      onlyRight: 9,
      changed: 8,
      truncated: true,
    });
    expect(difference.samples).toHaveLength(RUNTIME_MANIFEST_DIFF_SAMPLE_LIMIT);
    expect(difference.samples.every((sample) => !sample.path.startsWith('/'))).toBe(true);
  });

  it('reports an identity-only difference without inventing path differences', () => {
    const entries = [manifestEntry('one.txt')];
    const left = verifiedManifest(entries);
    const right = verifiedManifest(entries, 'b'.repeat(64), {
      status: 'verified',
      sha256: 'c'.repeat(64),
      userVersion: 1,
    });

    expect(compareRuntimeManifests(left, right)).toEqual({
      equal: false,
      onlyLeft: 0,
      onlyRight: 0,
      changed: 0,
      truncated: false,
      samples: [],
    });
  });

  it('keeps difference samples in manifest byte order for non-ASCII paths', () => {
    const privateUse = '\u{E000}.txt';
    const supplementary = '\u{10000}.txt';
    const left = verifiedManifest([manifestEntry(privateUse)], '1'.repeat(64));
    const right = verifiedManifest([manifestEntry(supplementary)], '2'.repeat(64));

    expect(compareRuntimeManifests(left, right).samples).toEqual([
      { path: privateUse, difference: 'only-left' },
      { path: supplementary, difference: 'only-right' },
    ]);
  });
});

describe('journal-authorized runtime stage copy', () => {
  it('durably writes the ownership marker before the first source entry', () => {
    const source = makeRuntime('marker-order-source');
    const destinationParent = makeRuntime('marker-order-parent');
    writeRuntimeFile(source, 'evidence.txt', 'preserved');
    const sourceManifest = inspectRuntimeTree(source, 'project-runtime');
    const events: RuntimeStageIoCheckpoint[] = [];
    const expectedStage = join(realpathSync(destinationParent), STAGE_BASENAME);

    const stage = materializeRuntimeStage(
      source,
      destinationParent,
      STAGE_BASENAME,
      sourceManifest,
      STAGE_OWNERSHIP,
      {
        checkpoint: (checkpoint) => {
          events.push(checkpoint);
          if (checkpoint !== 'before-first-source-entry') return;
          expect(readFileSync(join(expectedStage, RUNTIME_STAGE_OWNERSHIP_FILE), 'utf8')).toBe(
            encodeRuntimeStageOwnershipMarker(STAGE_OWNERSHIP),
          );
          expect(existsSync(join(expectedStage, 'evidence.txt'))).toBe(false);
        },
      },
    );

    expect(stage).toBe(expectedStage);
    expect(events).toEqual([
      'after-stage-mkdir',
      'after-marker-open',
      'after-marker-write',
      'after-marker-fsync',
      'after-marker-stage-fsync',
      'after-marker-parent-fsync',
      'before-first-source-entry',
      'before-source-entry',
      'after-source-file-chunk',
      'after-source-entry',
    ]);
    expect(readFileSync(join(stage, 'evidence.txt'), 'utf8')).toBe('preserved');
  });

  it('fails closed at every stage-marker crash window', () => {
    const source = makeRuntime('marker-crash-source');
    writeRuntimeFile(source, 'evidence.txt', 'preserved');
    const sourceManifest = inspectRuntimeTree(source, 'project-runtime');
    const checkpoints: readonly RuntimeStageIoCheckpoint[] = [
      'after-stage-mkdir',
      'after-marker-open',
      'after-marker-write',
      'after-marker-fsync',
      'after-marker-stage-fsync',
      'after-marker-parent-fsync',
      'before-first-source-entry',
    ];

    for (const target of checkpoints) {
      const destinationParent = makeRuntime(`marker-crash-${target}`);
      const stage = join(realpathSync(destinationParent), STAGE_BASENAME);
      expect(() =>
        materializeRuntimeStage(
          source,
          destinationParent,
          STAGE_BASENAME,
          sourceManifest,
          STAGE_OWNERSHIP,
          {
            checkpoint: (checkpoint) => {
              if (checkpoint === target) throw new Error(`crash:${target}`);
            },
          },
        ),
      ).toThrow(`crash:${target}`);

      expect(existsSync(stage)).toBe(true);
      expect(existsSync(join(stage, 'evidence.txt'))).toBe(false);
      const marker = join(stage, RUNTIME_STAGE_OWNERSHIP_FILE);
      if (target === 'after-stage-mkdir') {
        expect(existsSync(marker)).toBe(false);
      } else if (target === 'after-marker-open') {
        expect(readFileSync(marker)).toHaveLength(0);
      } else {
        expect(readFileSync(marker, 'utf8')).toBe(
          encodeRuntimeStageOwnershipMarker(STAGE_OWNERSHIP),
        );
        expect(() => assertRuntimeStageOwnershipMarker(stage, STAGE_OWNERSHIP)).not.toThrow();
      }
    }
  });

  it('does not create a marker in a stage-root replacement after mkdir', () => {
    const source = makeRuntime('stage-root-swap-source');
    writeRuntimeFile(source, 'evidence.txt', 'source');
    const sourceManifest = inspectRuntimeTree(source, 'project-runtime');
    const destinationParent = makeRuntime('stage-root-swap-parent');
    const stage = join(realpathSync(destinationParent), STAGE_BASENAME);
    const held = `${stage}.held`;

    expect(() =>
      materializeRuntimeStage(
        source,
        destinationParent,
        STAGE_BASENAME,
        sourceManifest,
        STAGE_OWNERSHIP,
        {
          checkpoint: (checkpoint) => {
            if (checkpoint !== 'after-stage-mkdir') return;
            renameSync(stage, held);
            makeDirectory(stage, 0o700);
            writeRuntimeFile(stage, 'customer.txt', 'preserve me');
          },
        },
      ),
    ).toThrow(expect.objectContaining({ reason: 'changed' }));

    expect(readFileSync(join(stage, 'customer.txt'), 'utf8')).toBe('preserve me');
    expect(existsSync(join(stage, RUNTIME_STAGE_OWNERSHIP_FILE))).toBe(false);
    if (process.platform !== 'win32') {
      expect(statSync(stage).mode & 0o777).toBe(0o700);
    }
  });

  it('holds every created directory while traversing nested entries', () => {
    const source = makeRuntime('nested-directory-swap-source');
    writeRuntimeFile(source, 'nested/evidence.txt', 'source');
    const sourceManifest = inspectRuntimeTree(source, 'project-runtime');
    const destinationParent = makeRuntime('nested-directory-swap-parent');
    const stage = join(realpathSync(destinationParent), STAGE_BASENAME);
    const nested = join(stage, 'nested');
    let swapped = false;

    expect(() =>
      materializeRuntimeStage(
        source,
        destinationParent,
        STAGE_BASENAME,
        sourceManifest,
        STAGE_OWNERSHIP,
        {
          checkpoint: (checkpoint, entryIndex) => {
            if (swapped || checkpoint !== 'before-source-entry' || entryIndex !== 1) {
              return;
            }
            swapped = true;
            renameSync(nested, `${nested}.held`);
            makeDirectory(nested, 0o700);
            writeRuntimeFile(nested, 'customer.txt', 'preserve me');
          },
        },
      ),
    ).toThrow(expect.objectContaining({ reason: 'changed' }));

    expect(swapped).toBe(true);
    expect(readFileSync(join(nested, 'customer.txt'), 'utf8')).toBe('preserve me');
    expect(existsSync(join(nested, 'evidence.txt'))).toBe(false);
  });

  it('does not chmod or fsync a stage-root replacement after an entry', () => {
    const source = makeRuntime('stage-finalize-swap-source');
    writeRuntimeFile(source, 'evidence.txt', 'source');
    const sourceManifest = inspectRuntimeTree(source, 'project-runtime');
    const destinationParent = makeRuntime('stage-finalize-swap-parent');
    const stage = join(realpathSync(destinationParent), STAGE_BASENAME);
    let swapped = false;

    expect(() =>
      materializeRuntimeStage(
        source,
        destinationParent,
        STAGE_BASENAME,
        sourceManifest,
        STAGE_OWNERSHIP,
        {
          checkpoint: (checkpoint) => {
            if (swapped || checkpoint !== 'after-source-entry') return;
            swapped = true;
            renameSync(stage, `${stage}.held`);
            makeDirectory(stage, 0o700);
            writeRuntimeFile(stage, 'customer.txt', 'preserve me');
          },
        },
      ),
    ).toThrow(expect.objectContaining({ reason: 'changed' }));

    expect(readFileSync(join(stage, 'customer.txt'), 'utf8')).toBe('preserve me');
    if (process.platform !== 'win32') {
      expect(statSync(stage).mode & 0o777).toBe(0o700);
    }
  });

  it('leaves only an owned recoverable stage when a later source entry changes', () => {
    const source = makeRuntime('per-entry-source-change');
    writeRuntimeFile(source, 'a.txt', 'stable-a');
    writeRuntimeFile(source, 'b.txt', 'stable-b');
    const sourceManifest = inspectRuntimeTree(source, 'project-runtime');
    const destinationParent = makeRuntime('per-entry-source-change-parent');
    const stage = join(realpathSync(destinationParent), STAGE_BASENAME);
    let changed = false;

    expect(() =>
      materializeRuntimeStage(
        source,
        destinationParent,
        STAGE_BASENAME,
        sourceManifest,
        STAGE_OWNERSHIP,
        {
          checkpoint: (checkpoint, entryIndex) => {
            if (changed || checkpoint !== 'before-source-entry' || entryIndex !== 1) return;
            changed = true;
            writeRuntimeFile(source, 'b.txt', 'changed!');
          },
        },
      ),
    ).toThrow(expect.objectContaining({ reason: 'changed' }));
    expect(changed).toBe(true);
    expect(readFileSync(join(stage, RUNTIME_STAGE_OWNERSHIP_FILE), 'utf8')).toBe(
      encodeRuntimeStageOwnershipMarker(STAGE_OWNERSHIP),
    );
  });

  it('detects a same-inode source mutation during streaming copy', () => {
    const source = makeRuntime('streaming-source-change');
    const sourcePath = join(source, 'large.bin');
    writeRuntimeFile(source, 'large.bin', 'a'.repeat(256 * 1024));
    const sourceManifest = inspectRuntimeTree(source, 'project-runtime');
    const destinationParent = makeRuntime('streaming-source-change-parent');
    const stage = join(realpathSync(destinationParent), STAGE_BASENAME);
    let changed = false;

    expect(() =>
      materializeRuntimeStage(
        source,
        destinationParent,
        STAGE_BASENAME,
        sourceManifest,
        STAGE_OWNERSHIP,
        {
          checkpoint: (checkpoint) => {
            if (changed || checkpoint !== 'after-source-file-chunk') return;
            changed = true;
            writeFileSync(sourcePath, 'z'.repeat(256 * 1024), { mode: 0o600 });
          },
        },
      ),
    ).toThrow(expect.objectContaining({ reason: 'changed' }));
    expect(changed).toBe(true);
    expect(readFileSync(join(stage, RUNTIME_STAGE_OWNERSHIP_FILE), 'utf8')).toBe(
      encodeRuntimeStageOwnershipMarker(STAGE_OWNERSHIP),
    );
  });

  it('rejects a foreign ownership identity before creating a stage', () => {
    const source = makeRuntime('foreign-owner-source');
    const destinationParent = makeRuntime('foreign-owner-parent');
    writeRuntimeFile(source, 'evidence.txt', 'preserved');
    const sourceManifest = inspectRuntimeTree(source, 'project-runtime');

    expectManifestFailure(
      () =>
        materializeRuntimeStage(source, destinationParent, STAGE_BASENAME, sourceManifest, {
          ...STAGE_OWNERSHIP,
          ownershipId: FOREIGN_STAGE_OWNERSHIP.ownershipId,
        }),
      'stage-ownership',
    );
    expect(existsSync(join(destinationParent, STAGE_BASENAME))).toBe(false);
  });

  it('omits only an exact expected stage marker from promotion evidence', () => {
    const source = makeRuntime('marker-posture-source');
    const destinationParent = makeRuntime('marker-posture-parent');
    writeRuntimeFile(source, 'evidence.txt', 'preserved');
    const stage = materializeRuntimeStage(
      source,
      destinationParent,
      STAGE_BASENAME,
      inspectRuntimeTree(source, 'project-runtime'),
      STAGE_OWNERSHIP,
    );

    const promotion = inspectVerifiedRuntimeManifest(stage, 'promotion-stage', {}, STAGE_OWNERSHIP);
    const ordinary = inspectVerifiedRuntimeManifest(stage, 'project-runtime');

    expect(promotion.entries.some((entry) => entry.path === RUNTIME_STAGE_OWNERSHIP_FILE)).toBe(
      false,
    );
    expect(ordinary.entries.some((entry) => entry.path === RUNTIME_STAGE_OWNERSHIP_FILE)).toBe(
      true,
    );
    expectManifestFailure(
      () => inspectVerifiedRuntimeManifest(stage, 'promotion-stage'),
      'stage-ownership',
    );
    expectManifestFailure(
      () => inspectVerifiedRuntimeManifest(stage, 'promotion-stage', {}, FOREIGN_STAGE_OWNERSHIP),
      'stage-ownership',
    );
  });

  it('detects ownership-marker tampering between manifest snapshots', () => {
    const source = makeRuntime('marker-tamper-source');
    const destinationParent = makeRuntime('marker-tamper-parent');
    writeRuntimeFile(source, 'evidence.txt', 'preserved');
    const stage = materializeRuntimeStage(
      source,
      destinationParent,
      STAGE_BASENAME,
      inspectRuntimeTree(source, 'project-runtime'),
      STAGE_OWNERSHIP,
    );
    let inspected = false;

    expectManifestFailure(
      () =>
        inspectVerifiedRuntimeManifest(
          stage,
          'promotion-stage',
          {
            inspectTree: (runtimeDir, posture, ownership) => {
              const tree = inspectRuntimeTree(runtimeDir, posture, {}, ownership);
              if (!inspected) {
                inspected = true;
                writeFileSync(join(stage, RUNTIME_STAGE_OWNERSHIP_FILE), '{"tampered":true}');
              }
              return tree;
            },
          },
          STAGE_OWNERSHIP,
        ),
      'stage-ownership',
    );
  });

  it('streams and verifies a nested runtime, its SQLite database, modes, and safe links', async () => {
    const source = makeCopySource();
    const destinationParent = makeCopyDestinationParent('copy-destination-parent');
    createValidDatastore(source);
    writeRuntimeFile(source, EPHEMERAL_MARKER_FILE, '{"kind":"ephemeral-project"}');
    const executable = writeRuntimeFile(source, 'plugins/tool/bin.js', '#!/usr/bin/env node');
    chmodSync(executable, 0o700);
    writeRuntimeFile(source, 'reports/latest.html', '<p>latest</p>');
    if (process.platform !== 'win32') {
      makeDirectory(join(source, 'plugins/.bin'));
      symlinkSync('../tool/bin.js', join(source, 'plugins/.bin/tool'));
    }
    const harness = authorityHarness();

    const result = await copyRuntimeToStage(copyInput(source, destinationParent, harness));

    expect(result.stageDir).toBe(join(realpathSync(destinationParent), STAGE_BASENAME));
    expect(result.source.identity).toEqual(result.stage.identity);
    expect(compareRuntimeManifests(result.source, result.stage).equal).toBe(true);
    expect(readFileSync(join(result.stageDir, 'reports/latest.html'), 'utf8')).toBe(
      '<p>latest</p>',
    );
    expect(existsSync(join(result.stageDir, EPHEMERAL_MARKER_FILE))).toBe(false);
    expect(existsSync(join(result.stageDir, RUNTIME_STAGE_OWNERSHIP_FILE))).toBe(true);
    expect(result.stage.entries.some((entry) => entry.path === RUNTIME_STAGE_OWNERSHIP_FILE)).toBe(
      false,
    );
    if (process.platform !== 'win32') {
      expect(statSync(join(result.stageDir, 'plugins/tool/bin.js')).mode & 0o777).toBe(0o700);
      expect(result.stage.identity.symlinkCount).toBe(1);
    }
    expect(harness.events).toEqual(['authorize', 'consume-authority']);
    expect(harness.authorize).toHaveBeenCalledTimes(1);
    expect(harness.assertAuthority).toHaveBeenCalledTimes(1);
  });

  it('rejects project-root replacement at the stage materialization boundary', async () => {
    const source = makeCopySource();
    const projectRoot = makeRuntime('copy-root-swap-project');
    const destinationParent = makeDirectory(join(projectRoot, 'opensip-cli'));
    const displaced = `${projectRoot}-displaced`;
    writeRuntimeFile(source, 'evidence.txt', 'source');
    const harness = authorityHarness();
    const input = {
      ...copyInput(source, destinationParent, harness),
      ...copyRootAuthority(realpathSync(projectRoot)),
    };
    let swapped = false;

    await expect(
      copyRuntimeToStage(input, {
        checkpoint: (checkpoint) => {
          if (swapped || checkpoint !== 'before-stage-materialization') return;
          swapped = true;
          renameSync(projectRoot, displaced);
          makeDirectory(destinationParent);
        },
      }),
    ).rejects.toThrow(/changed-after-preflight/iu);
    expect(swapped).toBe(true);
    expect(existsSync(join(destinationParent, STAGE_BASENAME))).toBe(false);
  });

  it('rejects an unrelated destination parent without mutating it', async () => {
    const source = makeCopySource();
    writeRuntimeFile(source, 'evidence.txt', 'preserved');
    const projectRoot = makeRuntime('unrelated-parent-project');
    makeDirectory(join(projectRoot, 'opensip-cli'));
    const unrelatedParent = makeRuntime('unrelated-parent');
    const sentinel = writeRuntimeFile(unrelatedParent, 'sentinel.txt', 'unrelated');
    const harness = authorityHarness();
    const materialize = vi.fn<RuntimeManifestDependencies['materialize']>();
    const authority = copyRootAuthority(realpathSync(projectRoot));

    await expect(
      copyRuntimeToStage(
        {
          controller: harness.controller,
          receipt: harness.receipt,
          sourceDir: source,
          sourcePosture: 'cache-source',
          destinationParent: realpathSync(unrelatedParent),
          stageBasename: STAGE_BASENAME,
          ...authority,
        },
        { materialize },
      ),
    ).rejects.toMatchObject({ reason: 'invalid-path' });

    expect(materialize).not.toHaveBeenCalled();
    expect(harness.authorize).not.toHaveBeenCalled();
    expect(readFileSync(sentinel, 'utf8')).toBe('unrelated');
    expect(existsSync(join(unrelatedParent, STAGE_BASENAME))).toBe(false);
  });

  it('rejects a cache source that does not match the journal-selected cache key', async () => {
    makeCopySource();
    const foreignSource = realpathSync(
      makeDirectory(join(resolveUserPaths().ephemeralProjectsDir, 'c'.repeat(24))),
    );
    const sentinel = writeRuntimeFile(foreignSource, 'sentinel.txt', 'foreign');
    const destinationParent = makeCopyDestinationParent('foreign-source-destination');
    const harness = authorityHarness();
    const materialize = vi.fn<RuntimeManifestDependencies['materialize']>();

    await expect(
      copyRuntimeToStage(copyInput(foreignSource, destinationParent, harness), {
        materialize,
      }),
    ).rejects.toMatchObject({ reason: 'invalid-path' });

    expect(materialize).not.toHaveBeenCalled();
    expect(harness.authorize).not.toHaveBeenCalled();
    expect(readFileSync(sentinel, 'utf8')).toBe('foreign');
    expect(existsSync(join(destinationParent, STAGE_BASENAME))).toBe(false);
  });

  it('rejects selected-cache bytes that no longer match the journal source manifest', async () => {
    const source = makeCopySource();
    const sourceFile = writeRuntimeFile(source, 'evidence.txt', 'before');
    const expected = inspectVerifiedRuntimeManifest(source, 'cache-source').identity;
    writeFileSync(sourceFile, 'after');
    const destinationParent = makeCopyDestinationParent('changed-source-destination');
    const harness = authorityHarness({ sourceManifest: expected });
    const materialize = vi.fn<RuntimeManifestDependencies['materialize']>();

    await expect(
      copyRuntimeToStage(copyInput(source, destinationParent, harness), {
        materialize,
      }),
    ).rejects.toMatchObject({ reason: 'changed' });

    expect(materialize).not.toHaveBeenCalled();
    expect(harness.authorize).not.toHaveBeenCalled();
    expect(existsSync(join(destinationParent, STAGE_BASENAME))).toBe(false);
  });

  it('rejects a destination-parent alias without following it', async () => {
    if (process.platform === 'win32') return;
    const source = makeCopySource();
    writeRuntimeFile(source, 'evidence.txt', 'preserved');
    const projectRoot = makeRuntime('alias-project');
    const destinationParent = makeDirectory(join(projectRoot, 'opensip-cli'));
    const aliasRoot = join(temporaryDirectory, 'alias-root');
    symlinkSync(projectRoot, aliasRoot);
    const harness = authorityHarness();
    const authority = copyRootAuthority(realpathSync(projectRoot));

    await expect(
      copyRuntimeToStage({
        controller: harness.controller,
        receipt: harness.receipt,
        sourceDir: source,
        sourcePosture: 'cache-source',
        destinationParent: join(aliasRoot, 'opensip-cli'),
        stageBasename: STAGE_BASENAME,
        ...authority,
      }),
    ).rejects.toMatchObject({ reason: 'invalid-path' });

    expect(existsSync(join(destinationParent, STAGE_BASENAME))).toBe(false);
    expect(harness.authorize).not.toHaveBeenCalled();
  });

  it('refuses materialization when durable journal authorization is unavailable', async () => {
    const source = makeCopySource();
    const destinationParent = makeCopyDestinationParent('unauthorized-parent');
    writeRuntimeFile(source, 'evidence.txt', 'preserved');
    const harness = authorityHarness({
      rejectAuthorization: new Error('journal intent is not durable'),
    });
    const materialize = vi.fn<RuntimeManifestDependencies['materialize']>();

    await expect(
      copyRuntimeToStage(copyInput(source, destinationParent, harness), {
        materialize,
      }),
    ).rejects.toThrow('journal intent is not durable');

    expect(materialize).not.toHaveBeenCalled();
    expect(existsSync(join(destinationParent, STAGE_BASENAME))).toBe(false);
    expect(harness.assertAuthority).not.toHaveBeenCalled();
  });

  it('rejects a lease not bound to the journal controller before inspection or mutation', async () => {
    const source = makeCopySource();
    const destinationParent = makeCopyDestinationParent('foreign-lease-parent');
    writeRuntimeFile(source, 'evidence.txt', 'preserved');
    const harness = authorityHarness({
      rejectLease: new Error('foreign lease'),
    });
    const materialize = vi.fn<RuntimeManifestDependencies['materialize']>();

    await expect(
      copyRuntimeToStage(copyInput(source, destinationParent, harness), {
        materialize,
      }),
    ).rejects.toThrow('foreign lease');
    expect(harness.verifyOpen).not.toHaveBeenCalled();
    expect(materialize).not.toHaveBeenCalled();
  });

  it('consumes the path-neutral authority before the first stage mutation', async () => {
    const source = makeCopySource();
    const destinationParent = makeCopyDestinationParent('authority-order-parent');
    writeRuntimeFile(source, 'evidence.txt', 'preserved');
    const harness = authorityHarness();
    const materialize = vi.fn<RuntimeManifestDependencies['materialize']>(
      (sourceDir, parent, basename, sourceManifest, ownership) => {
        harness.events.push('materialize');
        return materializeRuntimeStage(sourceDir, parent, basename, sourceManifest, ownership);
      },
    );

    await copyRuntimeToStage(copyInput(source, destinationParent, harness), {
      materialize,
    });

    expect(harness.events).toEqual(['authorize', 'consume-authority', 'materialize']);
  });

  it('fails closed without replacing a preexisting destination stage', async () => {
    const source = makeCopySource();
    const destinationParent = makeCopyDestinationParent('preexisting-parent');
    writeRuntimeFile(source, 'evidence.txt', 'new');
    const stage = makeDirectory(join(destinationParent, STAGE_BASENAME));
    writeRuntimeFile(stage, 'sentinel.txt', 'owned by another operation');
    const harness = authorityHarness();

    await expect(
      copyRuntimeToStage(copyInput(source, destinationParent, harness)),
    ).rejects.toMatchObject({ code: 'EEXIST' });

    expect(readFileSync(join(stage, 'sentinel.txt'), 'utf8')).toBe('owned by another operation');
    expect(existsSync(join(stage, 'evidence.txt'))).toBe(false);
  });

  it('preserves a preexisting stage with a foreign marker', async () => {
    const source = makeCopySource();
    const destinationParent = makeCopyDestinationParent('foreign-marker-parent');
    writeRuntimeFile(source, 'evidence.txt', 'new');
    const stage = makeDirectory(join(destinationParent, STAGE_BASENAME));
    writeRuntimeFile(
      stage,
      RUNTIME_STAGE_OWNERSHIP_FILE,
      encodeRuntimeStageOwnershipMarker(FOREIGN_STAGE_OWNERSHIP),
    );
    const markerBefore = readFileSync(join(stage, RUNTIME_STAGE_OWNERSHIP_FILE), 'utf8');
    const harness = authorityHarness();

    await expect(
      copyRuntimeToStage(copyInput(source, destinationParent, harness)),
    ).rejects.toMatchObject({ code: 'EEXIST' });

    expect(readFileSync(join(stage, RUNTIME_STAGE_OWNERSHIP_FILE), 'utf8')).toBe(markerBefore);
    expect(existsSync(join(stage, 'evidence.txt'))).toBe(false);
  });

  it('rejects a source collision with the reserved ownership marker', async () => {
    const source = makeCopySource();
    const destinationParent = makeCopyDestinationParent('reserved-marker-parent');
    writeRuntimeFile(source, RUNTIME_STAGE_OWNERSHIP_FILE, 'customer bytes');
    writeRuntimeFile(source, 'evidence.txt', 'preserved');
    const harness = authorityHarness();

    await expect(
      copyRuntimeToStage(copyInput(source, destinationParent, harness)),
    ).rejects.toMatchObject({ reason: 'stage-ownership' });

    const stage = join(destinationParent, STAGE_BASENAME);
    expect(existsSync(stage)).toBe(false);
    expect(readFileSync(join(source, RUNTIME_STAGE_OWNERSHIP_FILE), 'utf8')).toBe('customer bytes');
  });

  it('leaves a partial journal-owned stage in place when materialization fails', async () => {
    const source = makeCopySource();
    const destinationParent = makeCopyDestinationParent('partial-parent');
    writeRuntimeFile(source, 'evidence.txt', 'preserved');
    const harness = authorityHarness();
    const materialize = vi.fn<RuntimeManifestDependencies['materialize']>(
      (_source, parent, basename, _sourceManifest, ownership) => {
        const stage = makeDirectory(join(parent, basename));
        createRuntimeStageOwnershipMarker(stage, ownership);
        writeRuntimeFile(stage, 'partial.tmp', 'recoverable');
        throw Object.assign(new Error('injected fsync failure'), {
          code: 'EIO',
        });
      },
    );

    await expect(
      copyRuntimeToStage(copyInput(source, destinationParent, harness), {
        materialize,
      }),
    ).rejects.toThrow('injected fsync failure');

    expect(readFileSync(join(destinationParent, STAGE_BASENAME, 'partial.tmp'), 'utf8')).toBe(
      'recoverable',
    );
  });

  it('detects source mutation after stage materialization and preserves both candidates', async () => {
    const source = makeCopySource();
    const destinationParent = makeCopyDestinationParent('mutating-parent');
    const sourceFile = writeRuntimeFile(source, 'evidence.txt', 'before');
    const harness = authorityHarness();
    const checkpoints: RuntimeManifestCheckpoint[] = [];

    await expect(
      copyRuntimeToStage(copyInput(source, destinationParent, harness), {
        checkpoint: (checkpoint) => {
          checkpoints.push(checkpoint);
          if (checkpoint === 'after-stage-materialization') {
            writeFileSync(sourceFile, 'after');
            chmodSync(sourceFile, 0o600);
          }
        },
      }),
    ).rejects.toMatchObject({ reason: 'changed' });

    expect(checkpoints).toContain('after-stage-materialization');
    expect(readFileSync(sourceFile, 'utf8')).toBe('after');
    expect(readFileSync(join(destinationParent, STAGE_BASENAME, 'evidence.txt'), 'utf8')).toBe(
      'before',
    );
  });
});
