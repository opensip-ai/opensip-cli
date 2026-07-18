import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

import {
  acquireRuntimeExclusiveLease,
  EPHEMERAL_MARKER_FILE,
  EPHEMERAL_MARKER_VERSION,
  legacyEphemeralProjectCacheKey,
  resolveCoordinationPaths,
  resolveEphemeralProjectPaths,
  resolveProjectPaths,
  resolveUserPaths,
  touchEphemeralRuntime,
  type RuntimeExclusiveLease,
} from '@opensip-cli/core';
import {
  checkpointSqliteFile,
  DataStoreFactory,
  inspectSqliteFile,
  type DataStoreLockContext,
  type SqliteIntegrityResult,
} from '@opensip-cli/datastore';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { inspectRuntimeTree } from '../runtime-manifest-io.js';
import {
  assertStablePromotionDirectory,
  closeStablePromotionDirectory,
} from '../runtime-promotion-filesystem-io.js';
import {
  createInitialRuntimePromotionJournal,
  createRuntimePromotionOwnedSlots,
  type RuntimeManifestIdentity,
} from '../runtime-promotion-journal-schema.js';
import { bindRuntimePromotionDatastoreSet } from '../runtime-promotion-preflight-datastore-authority.js';
import { inspectRuntimePromotionFilesystem } from '../runtime-promotion-preflight-fs.js';
import {
  assertRuntimePromotionPreflightUnchanged,
  assertRuntimePromotionSourceRetirementUnchanged,
  checkpointRuntimePromotionDatastores,
  preflightRuntimePromotionAuthority,
  refreshRuntimePromotionSourceRetirementProof,
  type RuntimePromotionDatastoreError,
  RuntimePromotionPreflightError,
  selectRuntimePromotionAuthority,
} from '../runtime-promotion-preflight.js';
import {
  assertRuntimePromotionProjectRootAuthority,
  captureRuntimePromotionProjectRootAuthority,
} from '../runtime-promotion-root-authority.js';

import type { DurableOpenPromotionJournal } from '../runtime-promotion-journal.js';

const NOW = Date.parse('2026-07-17T12:00:00.000Z');
const LOCK_CONTEXT: DataStoreLockContext = {
  policy: { waitMs: 1000, staleMs: 30_000, heartbeatMs: 1000 },
  command: 'opensip init',
  cwdBasename: 'project',
};
const ABSENT_SIDECARS = {
  before: { wal: 'absent', shm: 'absent' },
  after: { wal: 'absent', shm: 'absent' },
} as const;

let home: string;
let project: string;
let priorHome: string | undefined;

function makeDirectory(path: string, mode = 0o700): string {
  mkdirSync(path, { recursive: true, mode });
  if (process.platform !== 'win32') chmodSync(path, mode);
  return path;
}

function writePrivate(path: string, content: string): void {
  makeDirectory(dirname(path));
  writeFileSync(path, content, { encoding: 'utf8', mode: 0o600 });
  if (process.platform !== 'win32') chmodSync(path, 0o600);
}

function matchingLease(projectRoot = project): RuntimeExclusiveLease {
  return {
    kind: 'runtime-exclusive',
    coordinationKey: resolveEphemeralProjectPaths(projectRoot).coordinationKey,
    posture: 'normal',
    ownerToken: 'preflight-test-owner-0001',
    acquiredAt: NOW,
    release: () => undefined,
  };
}

function datastoreRootAuthority(
  projectRoot = home,
  expectedKinds: readonly ('source' | 'destination')[] = ['source'],
): {
  readonly lease: RuntimeExclusiveLease;
  readonly projectRootAuthority: ReturnType<typeof captureRuntimePromotionProjectRootAuthority>;
  readonly controller: {
    readonly assertBoundLease: (candidate: RuntimeExclusiveLease) => void;
    readonly verifyOpen: (
      candidate: DurableOpenPromotionJournal,
    ) => Promise<ReturnType<typeof createInitialRuntimePromotionJournal>>;
  };
  readonly receipt: DurableOpenPromotionJournal;
  readonly journal: ReturnType<typeof createInitialRuntimePromotionJournal>;
} {
  const lease = matchingLease(projectRoot);
  const operationId = 'operation-1';
  const paths = resolveEphemeralProjectPaths(projectRoot);
  touchEphemeralRuntime(paths, NOW);
  const markerSha256 = createHash('sha256')
    .update(readFileSync(join(paths.runtimeDir, EPHEMERAL_MARKER_FILE)))
    .digest('hex');
  const sourceExpected = expectedKinds.includes('source');
  const destinationExpected = expectedKinds.includes('destination');
  let route: 'deduplicate-cache' | 'project-authority' | 'promote-cache';
  if (sourceExpected && destinationExpected) route = 'deduplicate-cache';
  else if (sourceExpected) route = 'promote-cache';
  else route = 'project-authority';
  const journal = createInitialRuntimePromotionJournal({
    coordinationKey: lease.coordinationKey,
    operationId,
    recoveryOwnerToken: 'recovery-owner-000000000001',
    route,
    destinationParentPreexisting: true,
    destinationRuntimePreexisting: destinationExpected,
    source: sourceExpected
      ? {
          classification: paths.identityStrength,
          cacheKey: paths.cacheKey,
          generationDigest: paths.generationDigest ?? null,
          markerSha256,
        }
      : {
          classification: 'none',
          cacheKey: null,
          generationDigest: null,
          markerSha256: null,
        },
    inputs: {
      conflict: 'abort',
      authoredMode: 'fresh',
      languages: ['typescript'],
      languageExplicit: false,
    },
    plan: {
      authoredDigest: 'c'.repeat(64),
      replayDigest: 'd'.repeat(64),
      mutationCount: 0,
    },
    owned: createRuntimePromotionOwnedSlots(operationId),
    createdAt: NOW,
  });
  const receipt = Object.freeze({
    operationId,
    recoveryOwnerToken: journal.recoveryOwnerToken,
    createdAt: NOW,
    coordinationKey: lease.coordinationKey,
    revision: 0,
    sha256: 'e'.repeat(64),
    state: 'open',
  }) as DurableOpenPromotionJournal;
  makeDirectory(
    resolveCoordinationPaths().forProject(lease.coordinationKey).projectCoordinationDir,
  );
  return {
    lease,
    projectRootAuthority: captureRuntimePromotionProjectRootAuthority({
      lease,
      projectRoot,
      expectedPosture: 'normal',
    }),
    controller: {
      assertBoundLease: (candidate) => {
        if (candidate !== lease) throw new Error('foreign lease');
      },
      verifyOpen: (candidate) => {
        if (candidate !== receipt) throw new Error('foreign receipt');
        return Promise.resolve(journal);
      },
    },
    receipt,
    journal,
  };
}

function datastoreSourceCandidate(projectRoot = home): {
  readonly kind: 'source';
  readonly runtimeDir: string;
} {
  const paths = resolveEphemeralProjectPaths(projectRoot);
  touchEphemeralRuntime(paths, NOW);
  return {
    kind: 'source',
    runtimeDir: paths.runtimeDir,
  };
}

function datastoreDestinationCandidate(projectRoot = home): {
  readonly kind: 'destination';
  readonly runtimeDir: string;
} {
  const runtimeDir = makeDirectory(resolveProjectPaths(projectRoot).runtimeDir);
  return { kind: 'destination', runtimeDir };
}

function datastoreCandidate(
  kind: 'source' | 'destination',
  _authority: ReturnType<typeof datastoreRootAuthority>,
  projectRoot = home,
): { readonly kind: typeof kind; readonly runtimeDir: string } {
  if (kind === 'source') return datastoreSourceCandidate(projectRoot);
  return datastoreDestinationCandidate(projectRoot);
}

function createDatastoreFile(runtimeDir: string): void {
  const datastore = DataStoreFactory.open({
    backend: 'sqlite',
    path: join(runtimeDir, 'datastore.sqlite'),
  });
  const closed = datastore.closeForLifecycle?.();
  if (closed !== undefined && (!closed.checkpointed || !closed.closed)) {
    throw new Error('datastore fixture did not close');
  }
}

function activeRuntime(content?: string): ReturnType<typeof resolveEphemeralProjectPaths> {
  const paths = resolveEphemeralProjectPaths(project);
  touchEphemeralRuntime(paths, NOW);
  if (process.platform !== 'win32') chmodSync(paths.runtimeDir, 0o700);
  if (content !== undefined) writePrivate(join(paths.runtimeDir, 'evidence.txt'), content);
  return paths;
}

function legacyRuntime(content = 'legacy'): string {
  const key = legacyEphemeralProjectCacheKey(project);
  const runtime = makeDirectory(join(resolveUserPaths().ephemeralProjectsDir, key));
  writeFileSync(
    join(runtime, EPHEMERAL_MARKER_FILE),
    JSON.stringify({
      projectDir: resolveEphemeralProjectPaths(project).projectDir,
      lastUsedAt: new Date(NOW).toISOString(),
    }),
    { mode: 0o644 },
  );
  if (process.platform !== 'win32') chmodSync(join(runtime, EPHEMERAL_MARKER_FILE), 0o644);
  writePrivate(join(runtime, 'evidence.txt'), content);
  return runtime;
}

function destinationRuntime(content?: string): string {
  const runtime = makeDirectory(resolveProjectPaths(project).runtimeDir);
  if (content !== undefined) writePrivate(join(runtime, 'evidence.txt'), content);
  return runtime;
}

function snapshotTree(root: string): readonly string[] {
  const output: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    let stat;
    try {
      stat = lstatSync(current);
    } catch {
      continue;
    }
    const name = relative(root, current) || '.';
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      output.push(`${name}:d:${String(stat.mode & 0o777)}`);
      const children = readdirSync(current).sort((left, right) => right.localeCompare(left));
      for (const child of children) pending.push(join(current, child));
    } else if (stat.isFile()) {
      output.push(
        `${name}:f:${String(stat.mode & 0o777)}:${createHash('sha256')
          .update(readFileSync(current))
          .digest('hex')}`,
      );
    } else {
      output.push(`${name}:unsafe`);
    }
  }
  return output.sort();
}

function absentIntegrity(): SqliteIntegrityResult {
  return {
    status: 'absent',
    reason: 'file-absent',
    sidecars: ABSENT_SIDECARS,
  };
}

function validIntegrity(seed = 'a'): SqliteIntegrityResult {
  return {
    status: 'valid',
    sizeBytes: 4096,
    sha256: seed.repeat(64).slice(0, 64),
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
    sidecars: ABSENT_SIDECARS,
  };
}

function unsupportedIntegrity(): SqliteIntegrityResult {
  const valid = validIntegrity();
  if (valid.status !== 'valid') throw new Error('expected valid fixture');
  return {
    ...valid,
    status: 'unsupported',
    reason: 'schema-newer-than-cli',
    userVersion: 2,
    supportedVersion: 1,
    supported: false,
  };
}

function guardedInspection(
  inspect: (path: string) => SqliteIntegrityResult,
): (path: string, options: { readonly beforeOpen: () => void }) => SqliteIntegrityResult {
  return (path, options) => {
    options.beforeOpen();
    return inspect(path);
  };
}

function verifiedIdentity(runtimeDir: string): RuntimeManifestIdentity {
  const tree = inspectRuntimeTree(runtimeDir, 'cache-source');
  return {
    digest: tree.sha256,
    rootMode: tree.rootMode,
    fileCount: tree.fileCount,
    directoryCount: tree.directoryCount,
    symlinkCount: tree.symlinkCount,
    totalBytes: tree.totalBytes,
    sqlite: { status: 'absent' },
  };
}

beforeEach(() => {
  priorHome = process.env.HOME;
  home = realpathSync(makeDirectory(mkdtempSync(join(tmpdir(), 'opensip-preflight-home-'))));
  project = realpathSync(makeDirectory(mkdtempSync(join(tmpdir(), 'opensip-preflight-project-'))));
  process.env.HOME = home;
});

afterEach(() => {
  if (priorHome === undefined) delete process.env.HOME;
  else process.env.HOME = priorHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

describe('closed fresh-authority policy', () => {
  it.each([
    {
      name: 'source absent',
      sourceClassification: 'none' as const,
      destinationRuntimePreexisting: false,
      requestedConflict: 'keep-project' as const,
      expected: {
        status: 'selected',
        route: 'authored-only',
        effectiveConflict: 'abort',
      },
    },
    {
      name: 'destination only',
      sourceClassification: 'none' as const,
      destinationRuntimePreexisting: true,
      requestedConflict: 'use-cache' as const,
      expected: {
        status: 'selected',
        route: 'project-authority',
        effectiveConflict: 'abort',
      },
    },
    {
      name: 'strong source only',
      sourceClassification: 'generation-bound' as const,
      destinationRuntimePreexisting: false,
      requestedConflict: 'abort' as const,
      expected: { status: 'selected', route: 'promote-cache' },
    },
    {
      name: 'keep project without destination',
      sourceClassification: 'generation-bound' as const,
      destinationRuntimePreexisting: false,
      requestedConflict: 'keep-project' as const,
      expected: {
        status: 'conflict',
        reason: 'keep-project-requires-destination',
      },
    },
    {
      name: 'weak source default',
      sourceClassification: 'path-only' as const,
      destinationRuntimePreexisting: false,
      requestedConflict: 'abort' as const,
      expected: {
        status: 'conflict',
        reason: 'weak-source-requires-use-cache',
      },
    },
    {
      name: 'weak source explicit',
      sourceClassification: 'legacy' as const,
      destinationRuntimePreexisting: false,
      requestedConflict: 'use-cache' as const,
      expected: { status: 'selected', route: 'promote-cache' },
    },
    {
      name: 'verified dedup',
      sourceClassification: 'generation-bound' as const,
      destinationRuntimePreexisting: true,
      requestedConflict: 'abort' as const,
      preliminaryEquality: 'verified-equal' as const,
      expected: { status: 'selected', route: 'deduplicate-cache' },
    },
    {
      name: 'divergent default',
      sourceClassification: 'generation-bound' as const,
      destinationRuntimePreexisting: true,
      requestedConflict: 'abort' as const,
      preliminaryEquality: 'verified-different' as const,
      expected: { status: 'conflict', reason: 'runtime-diverged' },
    },
    {
      name: 'strong keep project',
      sourceClassification: 'generation-bound' as const,
      destinationRuntimePreexisting: true,
      requestedConflict: 'keep-project' as const,
      expected: { status: 'selected', route: 'keep-project' },
    },
    {
      name: 'strong use cache',
      sourceClassification: 'generation-bound' as const,
      destinationRuntimePreexisting: true,
      requestedConflict: 'use-cache' as const,
      expected: { status: 'selected', route: 'promote-cache' },
    },
    {
      name: 'weak default cannot dedup',
      sourceClassification: 'legacy' as const,
      destinationRuntimePreexisting: true,
      requestedConflict: 'abort' as const,
      preliminaryEquality: 'verified-equal' as const,
      expected: { status: 'conflict', reason: 'weak-source-not-deduplicable' },
    },
    {
      name: 'weak keep project',
      sourceClassification: 'path-only' as const,
      destinationRuntimePreexisting: true,
      requestedConflict: 'keep-project' as const,
      expected: { status: 'selected', route: 'keep-project' },
    },
  ])('$name', ({ expected, ...input }) => {
    expect(selectRuntimePromotionAuthority(input)).toMatchObject(expected);
  });
});

describe('attempt-local project-root authority', () => {
  it.each(['normal', 'init-recovery'] as const)(
    'supports %s posture while ignoring owned-child timestamp changes',
    (posture) => {
      const normal = matchingLease(project);
      const lease = { ...normal, posture } satisfies RuntimeExclusiveLease;
      const authority = captureRuntimePromotionProjectRootAuthority({
        lease,
        projectRoot: project,
        expectedPosture: posture,
      });
      makeDirectory(join(project, 'owned-child'));
      expect(() => assertRuntimePromotionProjectRootAuthority({ lease, authority })).not.toThrow();
    },
  );

  it('rejects a renamed and recreated project root with the same path key', () => {
    const lease = matchingLease(project);
    const authority = captureRuntimePromotionProjectRootAuthority({
      lease,
      projectRoot: project,
      expectedPosture: 'normal',
    });
    const displaced = `${project}-displaced`;
    renameSync(project, displaced);
    makeDirectory(project);
    expect(() => assertRuntimePromotionProjectRootAuthority({ lease, authority })).toThrow(
      expect.objectContaining({ reason: 'changed-after-preflight' }),
    );
    rmSync(displaced, { recursive: true, force: true });
  });

  it('rejects a renamed and recreated preexisting destination parent', () => {
    const destinationParent = makeDirectory(join(project, 'opensip-cli'));
    const lease = matchingLease(project);
    const authority = captureRuntimePromotionProjectRootAuthority({
      lease,
      projectRoot: project,
      expectedPosture: 'normal',
    });
    const displaced = `${destinationParent}-displaced`;
    renameSync(destinationParent, displaced);
    makeDirectory(destinationParent);

    expect(() => assertRuntimePromotionProjectRootAuthority({ lease, authority })).toThrow(
      expect.objectContaining({ reason: 'changed-after-preflight' }),
    );
  });
});

describe('read-only runtime authority preflight', () => {
  it.each(['missing', 'non-directory'] as const)(
    'reports an existing cache as preserved when the project root is %s',
    (posture) => {
      const source = activeRuntime('preserve-me');
      const lease = matchingLease();
      const before = snapshotTree(source.runtimeDir);
      rmSync(project, { recursive: true, force: true });
      if (posture === 'non-directory') {
        writeFileSync(project, 'not a project directory', { mode: 0o600 });
        if (process.platform !== 'win32') chmodSync(project, 0o600);
      }

      expect(inspectRuntimePromotionFilesystem(project, lease)).toEqual({
        status: 'conflict',
        reason: 'project-path-unsafe',
        sourcePreserved: true,
      });
      expect(snapshotTree(source.runtimeDir)).toEqual(before);
    },
  );

  it('proves stable whole-tree equality without opening SQLite or creating a journal', async () => {
    const source = activeRuntime();
    const destination = destinationRuntime();
    const sourceStore = DataStoreFactory.open({
      backend: 'sqlite',
      path: join(source.runtimeDir, 'datastore.sqlite'),
    });
    sourceStore.closeForLifecycle?.();
    copyFileSync(
      join(source.runtimeDir, 'datastore.sqlite'),
      join(destination, 'datastore.sqlite'),
    );
    const beforeSource = snapshotTree(source.runtimeDir);
    const beforeProject = snapshotTree(project);
    const lease = await acquireRuntimeExclusiveLease({
      projectDir: project,
      posture: 'normal',
      command: 'opensip init',
    });
    try {
      const result = preflightRuntimePromotionAuthority({
        projectRoot: project,
        lease,
      });
      expect(result).toMatchObject({
        status: 'selected',
        route: 'deduplicate-cache',
        effectiveConflict: 'abort',
        preliminaryEquality: 'verified-equal',
      });
      expect(snapshotTree(source.runtimeDir)).toEqual(beforeSource);
      expect(snapshotTree(project)).toEqual(beforeProject);
      expect(lstatSync(source.runtimeDir).isDirectory()).toBe(true);
      expect(
        (() => {
          try {
            lstatSync(join(source.runtimeDir, 'datastore.sqlite-wal'));
            return true;
          } catch {
            return false;
          }
        })(),
      ).toBe(false);
      expect(
        (() => {
          try {
            lstatSync(
              resolveCoordinationPaths().forProject(lease.coordinationKey).promotionJournalFile,
            );
            return true;
          } catch {
            return false;
          }
        })(),
      ).toBe(false);
    } finally {
      lease.release();
    }
  });

  it('fails closed when active and legacy cache candidates both exist', () => {
    activeRuntime('active');
    legacyRuntime();
    expect(
      preflightRuntimePromotionAuthority({
        projectRoot: project,
        lease: matchingLease(),
      }),
    ).toEqual({
      status: 'conflict',
      reason: 'cache-candidates-ambiguous',
      effectiveConflict: 'abort',
      sourcePreserved: true,
      allowedPolicies: [],
    });
  });

  it('does not attribute an old generation cache to a recreated project root', () => {
    const old = activeRuntime('old-generation');
    const oldRuntime = old.runtimeDir;
    rmSync(project, { recursive: true, force: true });
    makeDirectory(project);
    expect(resolveEphemeralProjectPaths(project).runtimeDir).not.toBe(oldRuntime);
    const result = preflightRuntimePromotionAuthority({
      projectRoot: project,
      lease: matchingLease(),
    });
    expect(result).toMatchObject({
      status: 'selected',
      route: 'authored-only',
      source: { classification: 'none' },
    });
    expect(readFileSync(join(oldRuntime, 'evidence.txt'), 'utf8')).toBe('old-generation');
  });

  it('keeps path-only and stale-generation markers weak until use-cache is explicit', () => {
    symlinkSync('missing-gitdir', join(project, '.git'));
    const pathOnly = activeRuntime('weak');
    expect(pathOnly.identityStrength).toBe('path-only');
    expect(
      preflightRuntimePromotionAuthority({
        projectRoot: project,
        lease: matchingLease(),
      }),
    ).toMatchObject({
      status: 'conflict',
      reason: 'weak-source-requires-use-cache',
    });
    expect(
      preflightRuntimePromotionAuthority({
        projectRoot: project,
        lease: matchingLease(),
        conflict: 'use-cache',
      }),
    ).toMatchObject({
      status: 'selected',
      route: 'promote-cache',
      source: { classification: 'path-only', generationDigest: null },
    });

    rmSync(pathOnly.runtimeDir, { recursive: true, force: true });
    const current = resolveEphemeralProjectPaths(project);
    makeDirectory(current.runtimeDir);
    writeFileSync(
      join(current.runtimeDir, EPHEMERAL_MARKER_FILE),
      JSON.stringify({
        version: EPHEMERAL_MARKER_VERSION,
        projectDir: current.projectDir,
        canonicalRootDigest: current.canonicalRootDigest,
        identityStrength: 'path-only',
        lastUsedAt: new Date(NOW).toISOString(),
      }),
      { mode: 0o644 },
    );
    writePrivate(join(current.runtimeDir, 'evidence.txt'), 'stale');
    const stale = preflightRuntimePromotionAuthority({
      projectRoot: project,
      lease: matchingLease(),
      conflict: 'use-cache',
    });
    expect(stale).toMatchObject({
      status: 'selected',
      source: { classification: 'path-only' },
    });
  });

  it('downgrades a generation-mismatched active marker without retaining its stale digest', () => {
    const paths = resolveEphemeralProjectPaths(project);
    makeDirectory(paths.runtimeDir);
    writeFileSync(
      join(paths.runtimeDir, EPHEMERAL_MARKER_FILE),
      JSON.stringify({
        version: EPHEMERAL_MARKER_VERSION,
        projectDir: paths.projectDir,
        canonicalRootDigest: paths.canonicalRootDigest,
        identityStrength: 'generation-bound',
        generationDigest: '0'.repeat(64),
        lastUsedAt: new Date(NOW).toISOString(),
      }),
      { mode: 0o644 },
    );
    const result = preflightRuntimePromotionAuthority({
      projectRoot: project,
      lease: matchingLease(),
      conflict: 'use-cache',
    });
    expect(result).toMatchObject({
      status: 'selected',
      source: {
        classification: 'legacy',
        cacheKey: paths.cacheKey,
        generationDigest: null,
      },
    });
  });

  it('rejects malformed, changed, and permission-unsafe marker bytes', () => {
    const paths = resolveEphemeralProjectPaths(project);
    makeDirectory(paths.runtimeDir);
    const marker = join(paths.runtimeDir, EPHEMERAL_MARKER_FILE);
    writeFileSync(marker, '{', { mode: 0o644 });
    expect(
      preflightRuntimePromotionAuthority({
        projectRoot: project,
        lease: matchingLease(),
      }),
    ).toMatchObject({ status: 'conflict', reason: 'cache-marker-invalid' });

    rmSync(paths.runtimeDir, { recursive: true, force: true });
    activeRuntime('valid');
    expect(() =>
      preflightRuntimePromotionAuthority(
        {
          projectRoot: project,
          lease: matchingLease(),
        },
        {
          afterMarkerRead: () => {
            writeFileSync(marker, `${readFileSync(marker, 'utf8')} `);
          },
        },
      ),
    ).toThrow(expect.objectContaining({ reason: 'changed-after-preflight' }));

    rmSync(paths.runtimeDir, { recursive: true, force: true });
    activeRuntime('valid-again');
    if (process.platform !== 'win32') {
      chmodSync(marker, 0o666);
      expect(
        preflightRuntimePromotionAuthority({
          projectRoot: project,
          lease: matchingLease(),
        }),
      ).toMatchObject({ status: 'conflict', reason: 'cache-marker-invalid' });
    }
  });

  it('detects a new candidate and changed equal-tree content after preflight', () => {
    const source = activeRuntime('same');
    destinationRuntime('same');
    const result = preflightRuntimePromotionAuthority({
      projectRoot: project,
      lease: matchingLease(),
    });
    expect(result.status).toBe('selected');
    if (result.status !== 'selected') return;
    const legacy = legacyRuntime();
    expect(() =>
      assertRuntimePromotionPreflightUnchanged({
        lease: matchingLease(),
        token: result.revalidation,
      }),
    ).toThrow(expect.objectContaining({ reason: 'changed-after-preflight' }));

    rmSync(legacy, { recursive: true, force: true });
    writePrivate(join(source.runtimeDir, 'evidence.txt'), 'changed');
    expect(() =>
      assertRuntimePromotionPreflightUnchanged({
        lease: matchingLease(),
        token: result.revalidation,
      }),
    ).toThrow(RuntimePromotionPreflightError);
  });

  it('refreshes source retirement authority after checkpoint-side directory changes', () => {
    const source = activeRuntime('source');
    const selected = preflightRuntimePromotionAuthority({
      projectRoot: project,
      lease: matchingLease(),
    });
    expect(selected.status).toBe('selected');
    if (selected.status !== 'selected') return;
    writeFileSync(join(source.runtimeDir, 'datastore.sqlite-wal'), '');
    rmSync(join(source.runtimeDir, 'datastore.sqlite-wal'));
    expect(() =>
      assertRuntimePromotionPreflightUnchanged({
        lease: matchingLease(),
        token: selected.revalidation,
      }),
    ).toThrow(expect.objectContaining({ reason: 'changed-after-preflight' }));

    const proof = refreshRuntimePromotionSourceRetirementProof({
      lease: matchingLease(),
      preflight: selected,
      verifiedSource: verifiedIdentity(source.runtimeDir),
    });
    expect(() =>
      assertRuntimePromotionSourceRetirementUnchanged({
        lease: matchingLease(),
        proof,
      }),
    ).not.toThrow();
    writePrivate(join(source.runtimeDir, 'evidence.txt'), 'changed-after-verification');
    expect(() =>
      assertRuntimePromotionSourceRetirementUnchanged({
        lease: matchingLease(),
        proof,
      }),
    ).toThrow(expect.objectContaining({ reason: 'changed-after-preflight' }));
  });
});

describe('post-journal datastore checkpoint preparation', () => {
  it('checkpoints, closes, and inspects candidates strictly sequentially', async () => {
    const events: string[] = [];
    const source = datastoreSourceCandidate();
    const destination = datastoreDestinationCandidate();
    writePrivate(join(source.runtimeDir, 'datastore.sqlite'), 'source');
    writePrivate(join(destination.runtimeDir, 'datastore.sqlite'), 'destination');
    const candidates = [source, destination];
    const result = await checkpointRuntimePromotionDatastores(
      {
        candidates,
        lockContext: LOCK_CONTEXT,
        ...datastoreRootAuthority(home, ['source', 'destination']),
      },
      {
        mainFilePresence: () => 'file',
        checkpoint: (path) => {
          events.push(`checkpoint:${dirname(path)}`);
          return { checkpointed: true, closed: true };
        },
        inspect: (path, options) => {
          events.push(`inspect:${dirname(path)}`);
          options.beforeOpen();
          return validIntegrity(dirname(path) === source.runtimeDir ? 'a' : 'b');
        },
        afterCandidate: (kind) => events.push(`done:${kind}`),
      },
    );
    expect(result).toMatchObject([
      { kind: 'source', status: 'verified' },
      { kind: 'destination', status: 'verified' },
    ]);
    expect(events).toEqual([
      `checkpoint:${source.runtimeDir}`,
      `inspect:${source.runtimeDir}`,
      'done:source',
      `checkpoint:${destination.runtimeDir}`,
      `inspect:${destination.runtimeDir}`,
      'done:destination',
    ]);
  });

  it('rejects a present-file inspection that does not invoke its authority guard', async () => {
    const source = datastoreSourceCandidate();
    writePrivate(join(source.runtimeDir, 'datastore.sqlite'), 'source');

    await expect(
      checkpointRuntimePromotionDatastores(
        {
          candidates: [source],
          lockContext: LOCK_CONTEXT,
          ...datastoreRootAuthority(),
        },
        {
          mainFilePresence: () => 'file',
          checkpoint: () => ({ checkpointed: true, closed: true }),
          inspect: () => validIntegrity(),
        },
      ),
    ).rejects.toThrow(expect.objectContaining({ reason: 'database-invalid' }));
  });

  it.each([
    { sidecar: 'wal' as const, link: 'hardlink' as const },
    { sidecar: 'shm' as const, link: 'hardlink' as const },
    { sidecar: 'wal' as const, link: 'symlink' as const },
    { sidecar: 'shm' as const, link: 'symlink' as const },
  ])(
    'rejects an unsafe $link $sidecar sidecar before any datastore callback',
    async ({ sidecar, link }) => {
      const authority = datastoreRootAuthority();
      const candidate = datastoreSourceCandidate();
      createDatastoreFile(candidate.runtimeDir);
      const external = join(home, `external-${sidecar}-${link}`);
      const sentinel = `external-${sidecar}-${link}-sentinel`;
      writePrivate(external, sentinel);
      const sidecarPath = join(candidate.runtimeDir, `datastore.sqlite-${sidecar}`);
      rmSync(sidecarPath, { force: true });
      if (link === 'hardlink') linkSync(external, sidecarPath);
      else symlinkSync(external, sidecarPath, 'file');
      let callbacks = 0;

      await expect(
        checkpointRuntimePromotionDatastores(
          {
            candidates: [candidate],
            lockContext: LOCK_CONTEXT,
            ...authority,
          },
          {
            mainFilePresence: () => {
              callbacks += 1;
              return 'file';
            },
            checkpoint: () => {
              callbacks += 1;
              return { checkpointed: true, closed: true };
            },
            inspect: () => {
              callbacks += 1;
              return validIntegrity();
            },
          },
        ),
      ).rejects.toThrow(expect.objectContaining({ reason: 'database-invalid' }));

      expect(callbacks).toBe(0);
      expect(readFileSync(external, 'utf8')).toBe(sentinel);
    },
  );

  it.each([
    { sidecar: 'wal' as const, link: 'hardlink' as const },
    { sidecar: 'shm' as const, link: 'hardlink' as const },
    { sidecar: 'wal' as const, link: 'symlink' as const },
    { sidecar: 'shm' as const, link: 'symlink' as const },
  ])(
    'rejects an unsafe $link $sidecar sidecar introduced after native open',
    async ({ sidecar, link }) => {
      const authority = datastoreRootAuthority();
      const candidate = datastoreSourceCandidate();
      createDatastoreFile(candidate.runtimeDir);
      const databasePath = join(candidate.runtimeDir, 'datastore.sqlite');
      const external = join(home, `native-window-${sidecar}-${link}`);
      const sentinel = `native-window-${sidecar}-${link}-sentinel`;
      const sidecarPath = `${databasePath}-${sidecar}`;
      writePrivate(external, sentinel);
      let inserted = false;

      await expect(
        checkpointRuntimePromotionDatastores(
          {
            candidates: [candidate],
            lockContext: LOCK_CONTEXT,
            ...authority,
          },
          {
            checkpoint: (path, lockContext, options) =>
              checkpointSqliteFile(path, lockContext, {
                ...options,
                afterOpen: () => {
                  options.afterOpen();
                  rmSync(sidecarPath, { force: true });
                  if (link === 'hardlink') linkSync(external, sidecarPath);
                  else symlinkSync(external, sidecarPath, 'file');
                  inserted = true;
                },
              }),
          },
        ),
      ).rejects.toThrow(expect.objectContaining({ reason: 'checkpoint-incomplete' }));

      expect(inserted).toBe(true);
      expect(readFileSync(external, 'utf8')).toBe(sentinel);
    },
  );

  it.each(['wal', 'shm'] as const)(
    'rejects an ordinary owned $sidecar replacement after native-open authority was bound',
    async (sidecar) => {
      const authority = datastoreRootAuthority();
      const candidate = datastoreSourceCandidate();
      createDatastoreFile(candidate.runtimeDir);
      const databasePath = join(candidate.runtimeDir, 'datastore.sqlite');
      const sidecarPath = `${databasePath}-${sidecar}`;
      const sentinel = `ordinary-${sidecar}-replacement`;
      let replaced = false;

      await expect(
        checkpointRuntimePromotionDatastores(
          {
            candidates: [candidate],
            lockContext: LOCK_CONTEXT,
            ...authority,
          },
          {
            checkpoint: (path, lockContext, options) =>
              checkpointSqliteFile(path, lockContext, {
                ...options,
                afterOpen: () => {
                  options.afterOpen();
                  rmSync(sidecarPath, { force: true });
                  writePrivate(sidecarPath, sentinel);
                  replaced = true;
                },
              }),
          },
        ),
      ).rejects.toThrow(expect.objectContaining({ reason: 'checkpoint-incomplete' }));

      expect(replaced).toBe(true);
      expect(readFileSync(sidecarPath, 'utf8')).toBe(sentinel);
    },
  );

  it('rejects an ordinary owned sidecar replacement before inspection opens SQLite', async () => {
    const authority = datastoreRootAuthority();
    const candidate = datastoreSourceCandidate();
    createDatastoreFile(candidate.runtimeDir);
    const databasePath = join(candidate.runtimeDir, 'datastore.sqlite');
    const sidecarPath = `${databasePath}-wal`;
    const external = join(home, 'pre-inspection-sidecar');
    const sentinel = 'pre-inspection-sidecar-sentinel';
    writePrivate(external, sentinel);
    let passedAuthorityGuard = false;

    await expect(
      checkpointRuntimePromotionDatastores(
        {
          candidates: [candidate],
          lockContext: LOCK_CONTEXT,
          ...authority,
        },
        {
          inspect: (path, options) => {
            rmSync(sidecarPath, { force: true });
            renameSync(external, sidecarPath);
            return inspectSqliteFile(path, {
              beforeOpen: () => {
                options.beforeOpen();
                passedAuthorityGuard = true;
              },
            });
          },
        },
      ),
    ).rejects.toThrow(expect.objectContaining({ reason: 'database-invalid' }));

    expect(passedAuthorityGuard).toBe(false);
    expect(readFileSync(sidecarPath, 'utf8')).toBe(sentinel);
  });

  it('binds every main database before the first datastore callback', async () => {
    const authority = datastoreRootAuthority(home, ['source', 'destination']);
    const source = datastoreSourceCandidate();
    const destination = datastoreDestinationCandidate();
    createDatastoreFile(source.runtimeDir);
    createDatastoreFile(destination.runtimeDir);
    const destinationDatabase = join(destination.runtimeDir, 'datastore.sqlite');
    const displaced = `${destinationDatabase}-displaced`;
    let presenceCalls = 0;
    let checkpointCalls = 0;

    await expect(
      checkpointRuntimePromotionDatastores(
        {
          candidates: [source, destination],
          lockContext: LOCK_CONTEXT,
          ...authority,
        },
        {
          mainFilePresence: () => {
            presenceCalls += 1;
            if (presenceCalls === 1) {
              renameSync(destinationDatabase, displaced);
              createDatastoreFile(destination.runtimeDir);
            }
            return 'file';
          },
          checkpoint: () => {
            checkpointCalls += 1;
            return { checkpointed: true, closed: true };
          },
          inspect: guardedInspection(() => validIntegrity()),
        },
      ),
    ).rejects.toThrow(expect.objectContaining({ reason: 'database-invalid' }));

    expect(presenceCalls).toBe(1);
    expect(checkpointCalls).toBe(0);
  });

  it('rejects same-inode database mutation after integrity inspection', async () => {
    const authority = datastoreRootAuthority();
    const candidate = datastoreSourceCandidate();
    createDatastoreFile(candidate.runtimeDir);
    const databasePath = join(candidate.runtimeDir, 'datastore.sqlite');

    await expect(
      checkpointRuntimePromotionDatastores(
        {
          candidates: [candidate],
          lockContext: LOCK_CONTEXT,
          ...authority,
        },
        {
          checkpoint: () => ({ checkpointed: true, closed: true }),
          inspect: guardedInspection(() => validIntegrity()),
          afterCandidate: () => {
            writeFileSync(databasePath, 'same-inode replacement');
          },
        },
      ),
    ).rejects.toThrow(expect.objectContaining({ reason: 'database-invalid' }));
  });

  it('rejects a coordination projects-parent swap after journal verification', async () => {
    const authority = datastoreRootAuthority();
    const candidate = datastoreSourceCandidate();
    createDatastoreFile(candidate.runtimeDir);
    const coordination = resolveCoordinationPaths();
    const displaced = `${coordination.projectsDir}-displaced`;
    const externalProjects = makeDirectory(join(home, 'external-coordination-projects'));
    const externalProject = makeDirectory(
      join(externalProjects, authority.projectRootAuthority.coordinationKey),
    );
    writePrivate(join(externalProject, 'sentinel'), 'external');
    let callbacks = 0;

    await expect(
      checkpointRuntimePromotionDatastores(
        {
          candidates: [candidate],
          lockContext: LOCK_CONTEXT,
          ...authority,
          controller: {
            ...authority.controller,
            verifyOpen: async (receipt) => {
              const journal = await authority.controller.verifyOpen(receipt);
              renameSync(coordination.projectsDir, displaced);
              symlinkSync(externalProjects, coordination.projectsDir, 'dir');
              return journal;
            },
          },
        },
        {
          mainFilePresence: () => {
            callbacks += 1;
            return 'file';
          },
          checkpoint: () => {
            callbacks += 1;
            return { checkpointed: true, closed: true };
          },
          inspect: () => {
            callbacks += 1;
            return validIntegrity();
          },
        },
      ),
    ).rejects.toThrow(expect.objectContaining({ reason: 'candidate-set-invalid' }));

    expect(callbacks).toBe(0);
    expect(readdirSync(externalProject)).toEqual(['sentinel']);
    expect(readFileSync(join(externalProject, 'sentinel'), 'utf8')).toBe('external');
  });

  it('closes the source runtime handle when marker binding fails', () => {
    const authority = datastoreRootAuthority();
    const source = datastoreSourceCandidate();
    writePrivate(join(source.runtimeDir, EPHEMERAL_MARKER_FILE), '{}');
    const closed: string[] = [];

    expect(() =>
      bindRuntimePromotionDatastoreSet(
        {
          candidates: [source],
          journal: authority.journal,
          lease: authority.lease,
          projectRootAuthority: authority.projectRootAuthority,
        },
        {
          closeStableDirectory: (directory) => {
            closed.push(directory.path);
            closeStablePromotionDirectory(directory);
          },
        },
      ),
    ).toThrow();

    expect(closed).toContain(source.runtimeDir);
    expect(closed).toContain(resolveUserPaths().ephemeralProjectsDir);
  });

  it('closes a just-opened child when a post-open authority assertion fails', () => {
    const authority = datastoreRootAuthority();
    const source = datastoreSourceCandidate();
    const closed: string[] = [];

    expect(() =>
      bindRuntimePromotionDatastoreSet(
        {
          candidates: [source],
          journal: authority.journal,
          lease: authority.lease,
          projectRootAuthority: authority.projectRootAuthority,
        },
        {
          assertStableDirectory: (directory, description) => {
            assertStablePromotionDirectory(directory, description);
            throw new Error('injected authority failure');
          },
          closeStableDirectory: (directory) => {
            closed.push(directory.path);
            closeStablePromotionDirectory(directory);
          },
        },
      ),
    ).toThrow('injected authority failure');

    expect(closed).toContain(source.runtimeDir);
    expect(closed).toContain(resolveUserPaths().ephemeralProjectsDir);
  });

  it('accepts an absent main database only with proven-absent sidecars', async () => {
    let checkpoints = 0;
    await expect(
      checkpointRuntimePromotionDatastores(
        {
          candidates: [datastoreSourceCandidate()],
          lockContext: LOCK_CONTEXT,
          ...datastoreRootAuthority(),
        },
        {
          mainFilePresence: () => 'absent',
          checkpoint: () => {
            checkpoints += 1;
            return { checkpointed: true, closed: true };
          },
          inspect: absentIntegrity,
        },
      ),
    ).resolves.toEqual([{ kind: 'source', status: 'absent' }]);
    expect(checkpoints).toBe(0);
  });

  it('rejects project-root replacement before checkpointing a destination candidate', async () => {
    const projectRoot = makeDirectory(join(home, 'checkpoint-project'));
    const displaced = join(home, 'checkpoint-project-displaced');
    const source = datastoreSourceCandidate(projectRoot);
    const destination = datastoreDestinationCandidate(projectRoot);
    writePrivate(join(source.runtimeDir, 'datastore.sqlite'), 'source');
    writePrivate(join(destination.runtimeDir, 'datastore.sqlite'), 'destination');
    const events: string[] = [];
    await expect(
      checkpointRuntimePromotionDatastores(
        {
          candidates: [source, destination],
          lockContext: LOCK_CONTEXT,
          ...datastoreRootAuthority(projectRoot, ['source', 'destination']),
        },
        {
          mainFilePresence: () => 'file',
          checkpoint: (path) => {
            events.push(`checkpoint:${dirname(path)}`);
            return { checkpointed: true, closed: true };
          },
          inspect: guardedInspection((path) =>
            validIntegrity(dirname(path) === source.runtimeDir ? 'a' : 'b'),
          ),
          afterCandidate: (kind) => {
            if (kind !== 'source') return;
            renameSync(projectRoot, displaced);
            makeDirectory(projectRoot);
          },
        },
      ),
    ).rejects.toThrow(expect.objectContaining({ reason: 'changed-after-preflight' }));
    expect(events).toEqual([`checkpoint:${source.runtimeDir}`]);
    expect(readdirSync(projectRoot)).toEqual([]);
  });

  it.each([
    {
      name: 'unrelated destination',
      kind: 'destination' as const,
      candidate: () => ({
        kind: 'destination' as const,
        runtimeDir: makeDirectory(join(home, 'unrelated-destination')),
      }),
    },
    {
      name: 'source outside the authoritative cache root',
      kind: 'source' as const,
      candidate: () => {
        const source = datastoreSourceCandidate();
        return {
          ...source,
          runtimeDir: makeDirectory(join(home, 'unrelated-source')),
        };
      },
    },
    {
      name: 'source belonging to another syntactically valid cache key',
      kind: 'source' as const,
      candidate: () => {
        return {
          kind: 'source' as const,
          runtimeDir: makeDirectory(join(resolveUserPaths().ephemeralProjectsDir, 'a'.repeat(24))),
        };
      },
    },
  ])('rejects an $name before invoking datastore callbacks', async ({ candidate, kind }) => {
    let callbacks = 0;
    await expect(
      checkpointRuntimePromotionDatastores(
        {
          candidates: [candidate()],
          lockContext: LOCK_CONTEXT,
          ...datastoreRootAuthority(home, [kind]),
        },
        {
          mainFilePresence: () => {
            callbacks += 1;
            return 'file';
          },
          checkpoint: () => {
            callbacks += 1;
            return { checkpointed: true, closed: true };
          },
          inspect: () => {
            callbacks += 1;
            return validIntegrity();
          },
          afterCandidate: () => {
            callbacks += 1;
          },
        },
      ),
    ).rejects.toThrow(expect.objectContaining({ reason: 'candidate-set-invalid' }));
    expect(callbacks).toBe(0);
  });

  it('rejects another project cache even when a verified journal names its valid key', async () => {
    const authority = datastoreRootAuthority();
    const otherProject = makeDirectory(join(home, 'other-project'));
    const other = resolveEphemeralProjectPaths(otherProject);
    touchEphemeralRuntime(other, NOW);
    const markerSha256 = createHash('sha256')
      .update(readFileSync(join(other.runtimeDir, EPHEMERAL_MARKER_FILE)))
      .digest('hex');
    const foreignJournal = {
      ...authority.journal,
      source: {
        classification: other.identityStrength,
        cacheKey: other.cacheKey,
        generationDigest: other.generationDigest ?? null,
        markerSha256,
      },
    };
    let callbacks = 0;

    await expect(
      checkpointRuntimePromotionDatastores(
        {
          candidates: [{ kind: 'source', runtimeDir: other.runtimeDir }],
          lockContext: LOCK_CONTEXT,
          ...authority,
          controller: {
            ...authority.controller,
            verifyOpen: () => Promise.resolve(foreignJournal),
          },
        },
        {
          mainFilePresence: () => {
            callbacks += 1;
            return 'absent';
          },
          inspect: () => {
            callbacks += 1;
            return absentIntegrity();
          },
          checkpoint: () => {
            callbacks += 1;
            return { checkpointed: true, closed: true };
          },
        },
      ),
    ).rejects.toThrow(expect.objectContaining({ reason: 'candidate-set-invalid' }));
    expect(callbacks).toBe(0);
  });

  it('accepts an exact journal-selected weak current marker for explicit use-cache', async () => {
    const authority = datastoreRootAuthority();
    const source = datastoreSourceCandidate();
    const markerPath = join(source.runtimeDir, EPHEMERAL_MARKER_FILE);
    const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as Record<string, unknown>;
    marker.generationDigest = 'f'.repeat(64);
    writePrivate(markerPath, JSON.stringify(marker));
    const markerSha256 = createHash('sha256').update(readFileSync(markerPath)).digest('hex');
    const weakJournal = createInitialRuntimePromotionJournal({
      coordinationKey: authority.journal.coordinationKey,
      operationId: authority.journal.operationId,
      recoveryOwnerToken: authority.journal.recoveryOwnerToken,
      route: 'promote-cache',
      destinationParentPreexisting: true,
      destinationRuntimePreexisting: false,
      source: {
        classification: 'legacy',
        cacheKey: resolveEphemeralProjectPaths(home).cacheKey,
        generationDigest: null,
        markerSha256,
      },
      inputs: {
        ...authority.journal.inputs,
        conflict: 'use-cache',
      },
      plan: authority.journal.plan,
      owned: authority.journal.owned,
      createdAt: NOW,
    });

    await expect(
      checkpointRuntimePromotionDatastores(
        {
          candidates: [source],
          lockContext: LOCK_CONTEXT,
          ...authority,
          controller: {
            ...authority.controller,
            verifyOpen: () => Promise.resolve(weakJournal),
          },
        },
        {
          mainFilePresence: () => 'absent',
          inspect: absentIntegrity,
        },
      ),
    ).resolves.toEqual([{ kind: 'source', status: 'absent' }]);
  });

  it('validates the complete candidate set before processing an earlier valid candidate', async () => {
    let callbacks = 0;
    await expect(
      checkpointRuntimePromotionDatastores(
        {
          candidates: [
            datastoreSourceCandidate(),
            {
              kind: 'destination',
              runtimeDir: makeDirectory(join(home, 'unrelated-destination-after-source')),
            },
          ],
          lockContext: LOCK_CONTEXT,
          ...datastoreRootAuthority(home, ['source', 'destination']),
        },
        {
          mainFilePresence: () => {
            callbacks += 1;
            return 'file';
          },
          checkpoint: () => {
            callbacks += 1;
            return { checkpointed: true, closed: true };
          },
          inspect: () => {
            callbacks += 1;
            return validIntegrity();
          },
        },
      ),
    ).rejects.toThrow(expect.objectContaining({ reason: 'candidate-set-invalid' }));
    expect(callbacks).toBe(0);
  });

  it.each(
    (['source', 'destination'] as const).flatMap((kind) =>
      (['before-presence', 'between-presence-and-checkpoint', 'during-checkpoint'] as const).map(
        (window) => ({ kind, window }),
      ),
    ),
  )(
    'rejects a $kind ancestor swap $window without touching the external tree',
    async ({ kind, window }) => {
      const authority = datastoreRootAuthority(home, [kind]);
      const candidate = datastoreCandidate(kind, authority);
      createDatastoreFile(candidate.runtimeDir);
      const parent =
        kind === 'source'
          ? resolveUserPaths().ephemeralProjectsDir
          : resolveProjectPaths(home).userSourceDir;
      const displaced = `${parent}-displaced-${kind}-${window}`;
      const externalParent = makeDirectory(join(home, `external-${kind}-${window}`));
      const externalRuntime = makeDirectory(
        join(externalParent, candidate.runtimeDir.slice(parent.length + 1)),
      );
      const sentinels = {
        database: 'external-database',
        wal: 'external-wal',
        shm: 'external-shm',
        lock: 'external-lock',
      };
      writePrivate(join(externalRuntime, 'datastore.sqlite'), sentinels.database);
      writePrivate(join(externalRuntime, 'datastore.sqlite-wal'), sentinels.wal);
      writePrivate(join(externalRuntime, 'datastore.sqlite-shm'), sentinels.shm);
      writePrivate(join(externalRuntime, 'datastore.sqlite.write.lock'), sentinels.lock);
      const beforeEntries = readdirSync(externalRuntime).sort();
      let swapped = false;
      const swap = (): void => {
        if (swapped) return;
        swapped = true;
        renameSync(parent, displaced);
        symlinkSync(externalParent, parent, 'dir');
      };

      await expect(
        checkpointRuntimePromotionDatastores(
          {
            candidates: [candidate],
            lockContext: LOCK_CONTEXT,
            ...authority,
          },
          {
            ...(window === 'before-presence'
              ? {
                  mainFilePresence: () => {
                    swap();
                    return 'file' as const;
                  },
                }
              : {}),
            ...(window === 'between-presence-and-checkpoint' ? { beforeCheckpoint: swap } : {}),
            ...(window === 'during-checkpoint'
              ? {
                  checkpoint: (path, lockContext, options) =>
                    checkpointSqliteFile(path, lockContext, {
                      ...options,
                      afterOpen: swap,
                    }),
                }
              : {}),
          },
        ),
      ).rejects.toThrow();

      expect(swapped).toBe(true);
      expect(readdirSync(externalRuntime).sort()).toEqual(beforeEntries);
      expect(readFileSync(join(externalRuntime, 'datastore.sqlite'), 'utf8')).toBe(
        sentinels.database,
      );
      expect(readFileSync(join(externalRuntime, 'datastore.sqlite-wal'), 'utf8')).toBe(
        sentinels.wal,
      );
      expect(readFileSync(join(externalRuntime, 'datastore.sqlite-shm'), 'utf8')).toBe(
        sentinels.shm,
      );
      expect(readFileSync(join(externalRuntime, 'datastore.sqlite.write.lock'), 'utf8')).toBe(
        sentinels.lock,
      );
    },
  );

  it.each(['source', 'destination'] as const)(
    'rejects direct replacement of the $kind runtime root before checkpoint',
    async (kind) => {
      const authority = datastoreRootAuthority(home, [kind]);
      const candidate = datastoreCandidate(kind, authority);
      createDatastoreFile(candidate.runtimeDir);
      const displaced = `${candidate.runtimeDir}-displaced`;
      const externalRuntime = makeDirectory(join(home, `external-runtime-${kind}`));
      writePrivate(join(externalRuntime, 'sentinel'), 'external');

      await expect(
        checkpointRuntimePromotionDatastores(
          {
            candidates: [candidate],
            lockContext: LOCK_CONTEXT,
            ...authority,
          },
          {
            beforeCheckpoint: () => {
              renameSync(candidate.runtimeDir, displaced);
              symlinkSync(externalRuntime, candidate.runtimeDir, 'dir');
            },
          },
        ),
      ).rejects.toThrow();
      expect(readFileSync(join(externalRuntime, 'sentinel'), 'utf8')).toBe('external');
      expect(readdirSync(externalRuntime)).toEqual(['sentinel']);
    },
  );

  it.each(['between-presence-and-checkpoint', 'during-checkpoint'] as const)(
    'rejects exact database replacement $window without checkpointing the replacement',
    async (window) => {
      const authority = datastoreRootAuthority();
      const candidate = datastoreSourceCandidate();
      createDatastoreFile(candidate.runtimeDir);
      const databasePath = join(candidate.runtimeDir, 'datastore.sqlite');
      const displaced = `${databasePath}-displaced`;
      const replacement = 'replacement-database-sentinel';
      let swapped = false;
      const swap = (): void => {
        if (swapped) return;
        swapped = true;
        renameSync(databasePath, displaced);
        writePrivate(databasePath, replacement);
      };

      await expect(
        checkpointRuntimePromotionDatastores(
          {
            candidates: [candidate],
            lockContext: LOCK_CONTEXT,
            ...authority,
          },
          {
            ...(window === 'between-presence-and-checkpoint'
              ? { beforeCheckpoint: swap }
              : {
                  checkpoint: (path, lockContext, options) =>
                    checkpointSqliteFile(path, lockContext, {
                      ...options,
                      afterOpen: swap,
                    }),
                }),
          },
        ),
      ).rejects.toThrow();
      expect(swapped).toBe(true);
      expect(readFileSync(databasePath, 'utf8')).toBe(replacement);
      expect(() => lstatSync(`${databasePath}.write.lock`)).toThrow(
        expect.objectContaining({ code: 'ENOENT' }),
      );
    },
  );

  it.each([
    {
      name: 'incomplete checkpoint',
      overrides: {
        mainFilePresence: () => 'file' as const,
        checkpoint: () =>
          ({
            checkpointed: false,
            closed: true,
            reason: 'checkpoint-failed',
          }) as const,
        inspect: validIntegrity,
      },
      reason: 'checkpoint-incomplete',
    },
    {
      name: 'invalid database',
      overrides: {
        mainFilePresence: () => 'file' as const,
        checkpoint: () => ({ checkpointed: true, closed: true }) as const,
        inspect: guardedInspection(() => ({
          status: 'not-sqlite',
          reason: 'invalid-sqlite-header',
          sidecars: ABSENT_SIDECARS,
        })),
      },
      reason: 'database-invalid',
    },
    {
      name: 'unsupported database',
      overrides: {
        mainFilePresence: () => 'file' as const,
        checkpoint: () => ({ checkpointed: true, closed: true }) as const,
        inspect: guardedInspection(() => unsupportedIntegrity()),
      },
      reason: 'database-unsupported',
    },
  ])('rejects $name', async ({ overrides, reason }) => {
    const source = datastoreSourceCandidate();
    writePrivate(join(source.runtimeDir, 'datastore.sqlite'), 'source');
    await expect(
      checkpointRuntimePromotionDatastores(
        {
          candidates: [source],
          lockContext: LOCK_CONTEXT,
          ...datastoreRootAuthority(),
        },
        overrides,
      ),
    ).rejects.toThrow(expect.objectContaining({ reason }));
  });

  it('retains an unclosed native inspection proof in the promotion error', async () => {
    const source = datastoreSourceCandidate();
    writePrivate(join(source.runtimeDir, 'datastore.sqlite'), 'source');
    let failure: unknown;

    try {
      await checkpointRuntimePromotionDatastores(
        {
          candidates: [source],
          lockContext: LOCK_CONTEXT,
          ...datastoreRootAuthority(),
        },
        {
          mainFilePresence: () => 'file',
          checkpoint: () => ({ checkpointed: true, closed: true }),
          inspect: guardedInspection(() => ({
            status: 'unreadable',
            reason: 'native-close-failed',
            sidecars: ABSENT_SIDECARS,
          })),
        },
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      reason: 'database-unreadable',
      releaseSafe: false,
      closeResult: {
        checkpointed: true,
        closed: false,
        reason: 'native-close-failed',
      },
    });
  });

  it.each(['present', 'absent'] as const)(
    'retains an unclosed native inspection proof before %s-file post-inspection authority checks',
    async (presence) => {
      const source = datastoreSourceCandidate();
      const databasePath = join(source.runtimeDir, 'datastore.sqlite');
      if (presence === 'present') writePrivate(databasePath, 'source');
      let failure: unknown;

      try {
        await checkpointRuntimePromotionDatastores(
          {
            candidates: [source],
            lockContext: LOCK_CONTEXT,
            ...datastoreRootAuthority(),
          },
          {
            mainFilePresence: () => (presence === 'present' ? 'file' : 'absent'),
            checkpoint: () => ({ checkpointed: true, closed: true }),
            inspect: (_path, options) => {
              options.beforeOpen();
              writePrivate(databasePath, `post-inspection-${presence}`);
              return {
                status: 'unreadable',
                reason: 'native-close-failed',
                sidecars: ABSENT_SIDECARS,
              };
            },
          },
        );
      } catch (error) {
        failure = error;
      }

      expect(failure).toMatchObject({
        reason: 'database-unreadable',
        releaseSafe: false,
        closeResult: {
          closed: false,
          reason: 'native-close-failed',
        },
      });
    },
  );

  it('treats a throwing inspector as an unknown unclosed lifecycle failure', async () => {
    const source = datastoreSourceCandidate();
    writePrivate(join(source.runtimeDir, 'datastore.sqlite'), 'source');

    await expect(
      checkpointRuntimePromotionDatastores(
        {
          candidates: [source],
          lockContext: LOCK_CONTEXT,
          ...datastoreRootAuthority(),
        },
        {
          mainFilePresence: () => 'file',
          checkpoint: () => ({ checkpointed: true, closed: true }),
          inspect: () => {
            throw new Error('private inspector failure');
          },
        },
      ),
    ).rejects.toMatchObject({
      reason: 'database-unreadable',
      releaseSafe: false,
      closeResult: {
        checkpointed: false,
        closed: false,
        reason: 'checkpoint-and-close-failed',
      },
    });
  });

  it.each([
    {
      name: 'required source omission',
      expectedKinds: ['source'] as const,
      candidateKinds: [] as const,
    },
    {
      name: 'required destination omission',
      expectedKinds: ['destination'] as const,
      candidateKinds: [] as const,
    },
    {
      name: 'destination omission from a two-runtime journal',
      expectedKinds: ['source', 'destination'] as const,
      candidateKinds: ['source'] as const,
    },
    {
      name: 'source omission from a two-runtime journal',
      expectedKinds: ['source', 'destination'] as const,
      candidateKinds: ['destination'] as const,
    },
    {
      name: 'non-canonical destination-before-source order',
      expectedKinds: ['source', 'destination'] as const,
      candidateKinds: ['destination', 'source'] as const,
    },
  ])('rejects a $name before datastore callbacks', async ({ expectedKinds, candidateKinds }) => {
    let callbacks = 0;
    const candidates = candidateKinds.map((kind) =>
      kind === 'source' ? datastoreSourceCandidate() : datastoreDestinationCandidate(),
    );

    await expect(
      checkpointRuntimePromotionDatastores(
        {
          candidates,
          lockContext: LOCK_CONTEXT,
          ...datastoreRootAuthority(home, expectedKinds),
        },
        {
          mainFilePresence: () => {
            callbacks += 1;
            return 'file';
          },
          checkpoint: () => {
            callbacks += 1;
            return { checkpointed: true, closed: true };
          },
          inspect: () => {
            callbacks += 1;
            return validIntegrity();
          },
          afterCandidate: () => {
            callbacks += 1;
          },
        },
      ),
    ).rejects.toThrow(expect.objectContaining({ reason: 'candidate-set-invalid' }));
    expect(callbacks).toBe(0);
  });

  it('rejects duplicate kinds or runtime paths before checkpointing', async () => {
    const shared = makeDirectory(join(home, 'shared'));
    for (const { candidates, expectedKinds } of [
      {
        expectedKinds: ['source'] as const,
        candidates: [
          { kind: 'source' as const, runtimeDir: shared },
          {
            kind: 'source' as const,
            runtimeDir: join(home, 'other'),
          },
        ],
      },
      {
        expectedKinds: ['source', 'destination'] as const,
        candidates: [
          { kind: 'source' as const, runtimeDir: shared },
          { kind: 'destination' as const, runtimeDir: shared },
        ],
      },
    ]) {
      await expect(
        checkpointRuntimePromotionDatastores(
          {
            candidates,
            lockContext: LOCK_CONTEXT,
            ...datastoreRootAuthority(home, expectedKinds),
          },
          {
            mainFilePresence: () => 'file',
            checkpoint: () => {
              throw new Error('must not checkpoint');
            },
            inspect: validIntegrity,
          },
        ),
      ).rejects.toThrow(
        expect.objectContaining<Partial<RuntimePromotionDatastoreError>>({
          reason: 'candidate-set-invalid',
        }),
      );
    }
  });
});
