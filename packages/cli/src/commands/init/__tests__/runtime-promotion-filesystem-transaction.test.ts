import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveUserPaths } from '@opensip-cli/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { inspectRuntimeTree } from '../runtime-manifest-io.js';
import { RuntimeManifestError, type RuntimeStageOwnershipIdentity } from '../runtime-manifest.js';
import {
  capturePromotionRootIdentity,
  runtimePromotionFilesystemFailure,
} from '../runtime-promotion-filesystem-io.js';
import { markerForOwnedSlot } from '../runtime-promotion-filesystem-marker.js';
import {
  backupRuntimePromotionDestination,
  cleanupRuntimePromotionOwnedSlot,
  encodeRuntimePromotionArtifactMarker,
  installRuntimePromotionStage,
  retireRuntimePromotionSource,
  rollbackRuntimePromotion,
  runtimePromotionCleanupMarkerBasename,
  runtimePromotionOwnerMarkerBasename,
} from '../runtime-promotion-filesystem.js';
import { materializeRuntimeStage } from '../runtime-stage-io.js';

import {
  authorizeFilesystem,
  filesystemPaths,
  makeAuthorityHarness,
  makeFilesystemJournal,
  makePrivateDirectory,
  verifiedRuntime,
  writePrivateFile,
} from './runtime-promotion-filesystem-fixture.js';

import type { RuntimePromotionFilesystemCheckpoint } from '../runtime-promotion-filesystem.js';
import type {
  RuntimeManifestIdentity,
  RuntimePromotionJournal,
} from '../runtime-promotion-journal-schema.js';

let sandbox: string;
let home: string;
let project: string;
let priorHome: string | undefined;

beforeEach(() => {
  priorHome = process.env.HOME;
  sandbox = makePrivateDirectory(mkdtempSync(join(tmpdir(), 'opensip-runtime-fs-transaction-')));
  home = makePrivateDirectory(join(sandbox, 'home'));
  project = makePrivateDirectory(join(sandbox, 'project'));
  process.env.HOME = home;
});

afterEach(() => {
  if (priorHome === undefined) delete process.env.HOME;
  else process.env.HOME = priorHome;
  rmSync(sandbox, { recursive: true, force: true });
});

function ownership(journal: RuntimePromotionJournal): RuntimeStageOwnershipIdentity {
  return {
    operationId: journal.operationId,
    stageBasename: journal.owned.runtimeStage.basename,
    ownershipId: journal.owned.runtimeStage.ownershipId,
  };
}

function writeArtifactMarker(path: string, marker: ReturnType<typeof markerForOwnedSlot>): void {
  writePrivateFile(path, encodeRuntimePromotionArtifactMarker(marker));
}

function createDestinationParentOwner(
  journal: RuntimePromotionJournal,
): ReturnType<typeof filesystemPaths> {
  const paths = filesystemPaths(project, journal);
  makePrivateDirectory(paths.parent, 0o755);
  writeArtifactMarker(
    paths.parentMarker,
    markerForOwnedSlot(
      journal.operationId,
      'destinationParent',
      'owner',
      null,
      capturePromotionRootIdentity(paths.parent),
    ),
  );
  return paths;
}

function committedTerminal(
  manifest: RuntimeManifestIdentity,
): NonNullable<RuntimePromotionJournal['terminal']> {
  return {
    outcome: 'committed',
    authority: 'project',
    runtimeManifest: manifest,
    authoredVerified: true,
    sourcePreserved: false,
    verifiedAt: Date.parse('2026-07-17T12:01:00.000Z'),
  };
}

describe('forward rename transaction boundaries', () => {
  it('does not hide release-unsafe manifest evidence behind a filesystem error', () => {
    const manifestError = new RuntimeManifestError('sqlite-native-close-failed', {
      releaseSafe: false,
    });

    expect(() =>
      runtimePromotionFilesystemFailure('a runtime tree could not be verified', manifestError),
    ).toThrow(manifestError);
  });

  it('rechecks destination bytes after the backup before-hook', async () => {
    const parent = makePrivateDirectory(join(project, 'opensip-cli'));
    const runtime = makePrivateDirectory(join(parent, '.runtime'));
    writePrivateFile(join(runtime, 'evidence.txt'), 'verified-before-hook');
    const expected = verifiedRuntime(runtime);
    const journal = makeFilesystemJournal({
      action: 'destination-backup-create',
      projectRoot: project,
      destinationManifest: expected.identity,
      destinationParentPreexisting: true,
      destinationRuntimePreexisting: true,
    });
    const paths = filesystemPaths(project, journal);
    let mutated = false;
    const authority = await authorizeFilesystem(
      project,
      'destination-backup-create',
      makeAuthorityHarness(journal),
      {
        dependencies: {
          checkpoint: (checkpoint) => {
            if (
              !mutated &&
              checkpoint.boundary === 'before' &&
              checkpoint.effect === 'mutation' &&
              checkpoint.operation === 'destination-backup-rename'
            ) {
              mutated = true;
              writePrivateFile(join(runtime, 'evidence.txt'), 'changed-after-proof');
            }
          },
        },
      },
    );

    await expect(backupRuntimePromotionDestination(authority, expected.identity)).rejects.toThrow(
      /runtime tree|replaced or changed/u,
    );
    expect(existsSync(runtime)).toBe(true);
    expect(existsSync(paths.backup)).toBe(false);
  });

  it('retains created-parent ownership across install and rejects stage mutation at rename', async () => {
    const source = makePrivateDirectory(join(sandbox, 'install-source'));
    writePrivateFile(join(source, 'evidence.txt'), 'verified-stage');
    const expected = verifiedRuntime(source);
    const journal = makeFilesystemJournal({
      action: 'destination-install',
      projectRoot: project,
      route: 'promote-cache',
      stageManifest: expected.identity,
      destinationParentPreexisting: false,
      destinationRuntimePreexisting: false,
    });
    const paths = createDestinationParentOwner(journal);
    materializeRuntimeStage(
      source,
      paths.parent,
      journal.owned.runtimeStage.basename,
      inspectRuntimeTree(source, 'project-runtime'),
      ownership(journal),
    );
    let mutated = false;
    const authority = await authorizeFilesystem(
      project,
      'destination-install',
      makeAuthorityHarness(journal),
      {
        dependencies: {
          checkpoint: (checkpoint) => {
            if (
              !mutated &&
              checkpoint.boundary === 'before' &&
              checkpoint.effect === 'mutation' &&
              checkpoint.operation === 'destination-install-rename'
            ) {
              mutated = true;
              writePrivateFile(join(paths.stage, 'evidence.txt'), 'changed-after-stage-proof');
            }
          },
        },
      },
    );

    await expect(installRuntimePromotionStage(authority, expected.identity)).rejects.toThrow(
      /runtime tree/u,
    );
    expect(existsSync(paths.stage)).toBe(true);
    expect(existsSync(paths.runtime)).toBe(false);
    expect(existsSync(paths.parentMarker)).toBe(true);
  });

  it('installs an exact stage while retaining the created-parent marker', async () => {
    const source = makePrivateDirectory(join(sandbox, 'successful-install-source'));
    writePrivateFile(join(source, 'evidence.txt'), 'installed');
    const expected = verifiedRuntime(source);
    const journal = makeFilesystemJournal({
      action: 'destination-install',
      projectRoot: project,
      route: 'promote-cache',
      stageManifest: expected.identity,
      destinationParentPreexisting: false,
      destinationRuntimePreexisting: false,
    });
    const paths = createDestinationParentOwner(journal);
    materializeRuntimeStage(
      source,
      paths.parent,
      journal.owned.runtimeStage.basename,
      inspectRuntimeTree(source, 'project-runtime'),
      ownership(journal),
    );
    const authority = await authorizeFilesystem(
      project,
      'destination-install',
      makeAuthorityHarness(journal),
    );

    await expect(installRuntimePromotionStage(authority, expected.identity)).resolves.toMatchObject(
      { status: 'applied' },
    );
    expect(existsSync(paths.runtime)).toBe(true);
    expect(existsSync(paths.parentMarker)).toBe(true);
  });
});

describe('source retirement successor proof', () => {
  it('preserves cache authority when a byte-identical keep-project successor is replaced at the rename hook', async () => {
    const cacheKey = 'd'.repeat(24);
    const cacheParent = makePrivateDirectory(resolveUserPaths().ephemeralProjectsDir);
    const source = makePrivateDirectory(join(cacheParent, cacheKey));
    writePrivateFile(join(source, 'evidence.txt'), 'same-authority');
    const expected = verifiedRuntime(source, 'cache-source');
    const destination = makePrivateDirectory(join(project, 'opensip-cli', '.runtime'));
    writePrivateFile(join(destination, 'evidence.txt'), 'same-authority');
    const destinationExpected = verifiedRuntime(destination);
    const heldDestination = `${destination}.held`;
    const journal = makeFilesystemJournal({
      action: 'source-retire',
      projectRoot: project,
      route: 'keep-project',
      source: {
        classification: 'legacy',
        cacheKey,
        generationDigest: null,
        markerSha256: null,
        rootIdentity: capturePromotionRootIdentity(source),
      },
      sourceManifest: expected.identity,
      destinationManifest: destinationExpected.identity,
      destinationParentPreexisting: true,
      destinationRuntimePreexisting: true,
    });
    const authority = await authorizeFilesystem(
      project,
      'source-retire',
      makeAuthorityHarness(journal),
      {
        sourceRuntime: realpathSync(source),
        dependencies: {
          checkpoint: (checkpoint) => {
            if (
              checkpoint.boundary === 'before' &&
              checkpoint.effect === 'mutation' &&
              checkpoint.operation === 'source-retire-rename'
            ) {
              renameSync(destination, heldDestination);
              makePrivateDirectory(destination);
              writePrivateFile(join(destination, 'evidence.txt'), 'same-authority');
              expect(verifiedRuntime(destination).identity).toEqual(destinationExpected.identity);
            }
          },
        },
      },
    );

    await expect(retireRuntimePromotionSource(authority, expected.identity)).rejects.toThrow(
      /replaced after journal creation/u,
    );
    expect(existsSync(source)).toBe(true);
    expect(existsSync(join(cacheParent, journal.owned.sourceTombstone.basename))).toBe(false);
    expect(existsSync(destination)).toBe(true);
    expect(existsSync(heldDestination)).toBe(true);
  });
});

describe('installed rollback parent ownership', () => {
  it.each([
    { authoredCursor: 0, expectedParent: false, expectedMarker: false },
    { authoredCursor: 1, expectedParent: true, expectedMarker: true },
  ])(
    'settles the created parent according to authored cursor $authoredCursor',
    async ({ authoredCursor, expectedParent, expectedMarker }) => {
      const provisional = makeFilesystemJournal({
        action: 'runtime-rollback',
        projectRoot: project,
        destinationParentPreexisting: false,
        runtimeInstallState: 'installed',
        authoredCursor,
      });
      const paths = createDestinationParentOwner(provisional);
      const runtime = makePrivateDirectory(paths.runtime);
      writePrivateFile(join(runtime, 'evidence.txt'), 'installed-runtime');
      if (authoredCursor > 0) {
        writePrivateFile(join(paths.parent, 'authored.yml'), 'authored-state');
      }
      const installed = verifiedRuntime(runtime);
      const journal = makeFilesystemJournal({
        action: 'runtime-rollback',
        projectRoot: project,
        destinationParentPreexisting: false,
        runtimeInstallState: 'installed',
        stageManifest: installed.identity,
        authoredCursor,
      });
      const authority = await authorizeFilesystem(
        project,
        'runtime-rollback',
        makeAuthorityHarness(journal),
      );

      await expect(
        rollbackRuntimePromotion(authority, {
          installed: installed.identity,
          backup: null,
          installedWasAuthoritative: true,
        }),
      ).resolves.toMatchObject({
        status: 'rolled-back',
        runtimeInstallState: 'rolled-back',
      });
      expect(existsSync(paths.runtime)).toBe(false);
      expect(existsSync(paths.parent)).toBe(expectedParent);
      expect(existsSync(paths.parentMarker)).toBe(expectedMarker);
    },
  );

  it('preserves an empty destination-parent replacement during rollback', async () => {
    const journal = makeFilesystemJournal({
      action: 'runtime-rollback',
      projectRoot: project,
      destinationParentPreexisting: false,
      runtimeInstallState: 'not-installed',
    });
    const paths = createDestinationParentOwner(journal);
    renameSync(paths.parent, `${paths.parent}.held`);
    makePrivateDirectory(paths.parent, 0o755);
    const replacement = lstatSync(paths.parent, { bigint: true });
    const authority = await authorizeFilesystem(
      project,
      'runtime-rollback',
      makeAuthorityHarness(journal),
    );

    await expect(
      rollbackRuntimePromotion(authority, {
        installed: null,
        backup: null,
        installedWasAuthoritative: false,
      }),
    ).rejects.toThrow(/exact owner marker/u);
    const after = lstatSync(paths.parent, { bigint: true });
    expect({ dev: after.dev, ino: after.ino }).toEqual({
      dev: replacement.dev,
      ino: replacement.ino,
    });
  });

  it('rejects a forged installed posture before deleting the installed runtime', async () => {
    const journal = makeFilesystemJournal({
      action: 'runtime-rollback',
      projectRoot: project,
      destinationParentPreexisting: true,
      runtimeInstallState: 'installed',
    });
    const paths = filesystemPaths(project, journal);
    const runtime = makePrivateDirectory(paths.runtime);
    writePrivateFile(join(runtime, 'evidence.txt'), 'installed-runtime');
    const installed = verifiedRuntime(runtime);
    const bound = makeFilesystemJournal({
      action: 'runtime-rollback',
      projectRoot: project,
      destinationParentPreexisting: true,
      runtimeInstallState: 'installed',
      stageManifest: installed.identity,
    });
    const authority = await authorizeFilesystem(
      project,
      'runtime-rollback',
      makeAuthorityHarness(bound),
    );

    await expect(
      rollbackRuntimePromotion(authority, {
        installed: installed.identity,
        backup: null,
        installedWasAuthoritative: false,
      }),
    ).rejects.toThrow(/install posture/u);
    expect(existsSync(runtime)).toBe(true);
  });
});

interface CleanupFixture {
  readonly journal: RuntimePromotionJournal;
  readonly paths: ReturnType<typeof filesystemPaths>;
  readonly backupIdentity: RuntimeManifestIdentity;
}

function destinationBackupCleanupFixture(): CleanupFixture {
  const parent = makePrivateDirectory(join(project, 'opensip-cli'));
  const current = makePrivateDirectory(join(parent, '.runtime'));
  writePrivateFile(join(current, 'current.txt'), 'current-authority');
  const currentIdentity = verifiedRuntime(current).identity;
  const provisional = makeFilesystemJournal({
    action: 'owned-slot-cleanup',
    projectRoot: project,
    cleanupSlot: 'destinationBackup',
  });
  const paths = filesystemPaths(project, provisional);
  const backup = makePrivateDirectory(paths.backup);
  writePrivateFile(join(backup, 'backup.txt'), 'old-backup');
  const backupIdentity = verifiedRuntime(backup).identity;
  const journal = makeFilesystemJournal({
    action: 'owned-slot-cleanup',
    projectRoot: project,
    cleanupSlot: 'destinationBackup',
    destinationManifest: backupIdentity,
    terminal: committedTerminal(currentIdentity),
  });
  writeArtifactMarker(
    paths.backupMarker,
    markerForOwnedSlot(
      journal.operationId,
      'destinationBackup',
      'owner',
      backupIdentity,
      capturePromotionRootIdentity(backup),
    ),
  );
  return { journal, paths, backupIdentity };
}

describe('closed cleanup write-ahead proof', () => {
  it('preserves a resumed source tombstone when its keep-project successor is replaced at the delete boundary', async () => {
    const cacheKey = '7'.repeat(24);
    const cacheParent = makePrivateDirectory(resolveUserPaths().ephemeralProjectsDir);
    const destination = makePrivateDirectory(join(project, 'opensip-cli', '.runtime'));
    writePrivateFile(join(destination, 'current.txt'), 'project-authority');
    const destinationManifest = verifiedRuntime(destination);
    const provisional = makeFilesystemJournal({
      action: 'owned-slot-cleanup',
      projectRoot: project,
      route: 'keep-project',
      destinationRuntimePreexisting: true,
      destinationManifest: destinationManifest.identity,
      source: {
        classification: 'legacy',
        cacheKey,
        generationDigest: null,
        markerSha256: null,
        rootIdentity: { device: '1', inode: '2' },
      },
      cleanupSlot: 'sourceTombstone',
    });
    const tombstone = makePrivateDirectory(
      join(cacheParent, provisional.owned.sourceTombstone.basename),
    );
    writePrivateFile(join(tombstone, 'old.txt'), 'cache-authority');
    const tombstoneManifest = verifiedRuntime(tombstone, 'cache-source');
    const journal = makeFilesystemJournal({
      action: 'owned-slot-cleanup',
      projectRoot: project,
      route: 'keep-project',
      destinationRuntimePreexisting: true,
      destinationManifest: destinationManifest.identity,
      source: {
        classification: 'legacy',
        cacheKey,
        generationDigest: null,
        markerSha256: null,
        rootIdentity: capturePromotionRootIdentity(tombstone),
      },
      sourceManifest: tombstoneManifest.identity,
      cleanupSlot: 'sourceTombstone',
      terminal: committedTerminal(destinationManifest.identity),
    });
    const rootIdentity = capturePromotionRootIdentity(tombstone);
    const ownerPath = join(
      cacheParent,
      runtimePromotionOwnerMarkerBasename(journal.owned.sourceTombstone.basename),
    );
    const cleanupPath = join(
      cacheParent,
      runtimePromotionCleanupMarkerBasename(journal.owned.sourceTombstone.basename),
    );
    writeArtifactMarker(
      ownerPath,
      markerForOwnedSlot(
        journal.operationId,
        'sourceTombstone',
        'owner',
        tombstoneManifest.identity,
        rootIdentity,
      ),
    );
    writeArtifactMarker(
      cleanupPath,
      markerForOwnedSlot(
        journal.operationId,
        'sourceTombstone',
        'cleanup',
        tombstoneManifest.identity,
        rootIdentity,
      ),
    );
    const heldDestination = `${destination}.held`;
    let swapped = false;
    const authority = await authorizeFilesystem(
      project,
      'owned-slot-cleanup',
      makeAuthorityHarness(journal),
      {
        cleanupSlot: 'sourceTombstone',
        sourceRuntime: join(realpathSync(cacheParent), cacheKey),
        dependencies: {
          checkpoint: (checkpoint) => {
            if (
              !swapped &&
              checkpoint.boundary === 'before' &&
              checkpoint.effect === 'mutation' &&
              checkpoint.operation === 'owned-entry-unlink'
            ) {
              swapped = true;
              renameSync(destination, heldDestination);
              makePrivateDirectory(destination);
              writePrivateFile(join(destination, 'current.txt'), 'project-authority');
              expect(verifiedRuntime(destination).identity).toEqual(destinationManifest.identity);
            }
          },
        },
      },
    );

    await expect(cleanupRuntimePromotionOwnedSlot(authority)).rejects.toThrow(
      /replaced after journal creation/u,
    );
    expect(readFileSync(join(tombstone, 'old.txt'), 'utf8')).toBe('cache-authority');
    expect(existsSync(ownerPath)).toBe(true);
    expect(existsSync(cleanupPath)).toBe(true);
    expect(existsSync(destination)).toBe(true);
    expect(existsSync(heldDestination)).toBe(true);
  });

  it('preserves an identical backup replacement that lacks the recorded inode binding', async () => {
    const fixture = destinationBackupCleanupFixture();
    const originalRootIdentity = capturePromotionRootIdentity(fixture.paths.backup);
    const replacement = makePrivateDirectory(
      join(fixture.paths.parent, 'cleanup-backup-replacement'),
    );
    writePrivateFile(join(replacement, 'backup.txt'), 'old-backup');
    expect(capturePromotionRootIdentity(replacement)).not.toEqual(originalRootIdentity);
    expect(verifiedRuntime(replacement).identity).toEqual(fixture.backupIdentity);
    rmSync(fixture.paths.backup, { recursive: true, force: true });
    renameSync(replacement, fixture.paths.backup);
    const authority = await authorizeFilesystem(
      project,
      'owned-slot-cleanup',
      makeAuthorityHarness(fixture.journal),
      { cleanupSlot: 'destinationBackup' },
    );

    await expect(cleanupRuntimePromotionOwnedSlot(authority)).rejects.toThrow(
      /replaced after journal creation/u,
    );
    expect(existsSync(fixture.paths.backup)).toBe(true);
    expect(readFileSync(join(fixture.paths.backup, 'backup.txt'), 'utf8')).toBe('old-backup');
  });

  it('revalidates the current successor after the cleanup-marker before-hook', async () => {
    const fixture = destinationBackupCleanupFixture();
    const cleanupMarker = join(
      fixture.paths.parent,
      runtimePromotionCleanupMarkerBasename(fixture.journal.owned.destinationBackup.basename),
    );
    const authority = await authorizeFilesystem(
      project,
      'owned-slot-cleanup',
      makeAuthorityHarness(fixture.journal),
      {
        cleanupSlot: 'destinationBackup',
        dependencies: {
          checkpoint: (checkpoint: RuntimePromotionFilesystemCheckpoint) => {
            if (
              checkpoint.boundary === 'before' &&
              checkpoint.effect === 'mutation' &&
              checkpoint.operation === 'owned-cleanup-marker-create'
            ) {
              rmSync(fixture.paths.runtime, { recursive: true, force: true });
            }
          },
        },
      },
    );

    await expect(cleanupRuntimePromotionOwnedSlot(authority)).rejects.toThrow();
    expect(existsSync(cleanupMarker)).toBe(false);
    expect(existsSync(fixture.paths.backup)).toBe(true);
    expect(existsSync(fixture.paths.backupMarker)).toBe(true);
  });

  it('re-reads external ownership after the cleanup-marker before-hook', async () => {
    const fixture = destinationBackupCleanupFixture();
    const cleanupMarker = join(
      fixture.paths.parent,
      runtimePromotionCleanupMarkerBasename(fixture.journal.owned.destinationBackup.basename),
    );
    const heldOwner = `${fixture.paths.backupMarker}.held`;
    const authority = await authorizeFilesystem(
      project,
      'owned-slot-cleanup',
      makeAuthorityHarness(fixture.journal),
      {
        cleanupSlot: 'destinationBackup',
        dependencies: {
          checkpoint: (checkpoint) => {
            if (
              checkpoint.boundary === 'before' &&
              checkpoint.effect === 'mutation' &&
              checkpoint.operation === 'owned-cleanup-marker-create'
            ) {
              renameSync(fixture.paths.backupMarker, heldOwner);
              writePrivateFile(fixture.paths.backupMarker, 'foreign owner');
            }
          },
        },
      },
    );

    await expect(cleanupRuntimePromotionOwnedSlot(authority)).rejects.toThrow(/owner changed/u);
    expect(existsSync(cleanupMarker)).toBe(false);
    expect(existsSync(fixture.paths.backup)).toBe(true);
    expect(existsSync(fixture.paths.backupMarker)).toBe(true);
    expect(existsSync(heldOwner)).toBe(true);
  });

  it('cleans the old backup when the current successor changed but remains valid', async () => {
    const fixture = destinationBackupCleanupFixture();
    writePrivateFile(join(fixture.paths.runtime, 'later-run.txt'), 'valid-later-run-change');
    const authority = await authorizeFilesystem(
      project,
      'owned-slot-cleanup',
      makeAuthorityHarness(fixture.journal),
      { cleanupSlot: 'destinationBackup' },
    );

    await expect(cleanupRuntimePromotionOwnedSlot(authority)).resolves.toEqual({
      slot: 'destinationBackup',
      status: 'removed',
    });
    expect(existsSync(fixture.paths.runtime)).toBe(true);
    expect(existsSync(fixture.paths.backup)).toBe(false);
    expect(existsSync(fixture.paths.backupMarker)).toBe(false);
  });

  it('does not reinterpret old database evidence after terminal authority closed', async () => {
    const fixture = destinationBackupCleanupFixture();
    const terminal = fixture.journal.terminal;
    if (terminal === null) {
      throw new Error('cleanup fixture lacks terminal project authority');
    }
    if (terminal.runtimeManifest === null) {
      throw new Error('cleanup fixture lacks terminal project authority');
    }
    const journal = {
      ...fixture.journal,
      terminal: {
        ...terminal,
        runtimeManifest: {
          ...terminal.runtimeManifest,
          sqlite: {
            status: 'verified' as const,
            sha256: 'f'.repeat(64),
            userVersion: 1,
          },
        },
      },
    };
    const authority = await authorizeFilesystem(
      project,
      'owned-slot-cleanup',
      makeAuthorityHarness(journal),
      { cleanupSlot: 'destinationBackup' },
    );

    await expect(cleanupRuntimePromotionOwnedSlot(authority)).resolves.toEqual({
      slot: 'destinationBackup',
      status: 'removed',
    });
    expect(existsSync(fixture.paths.runtime)).toBe(true);
    expect(existsSync(fixture.paths.backup)).toBe(false);
    expect(existsSync(fixture.paths.backupMarker)).toBe(false);
  });

  it('fails closed when the cleanup root is replaced at its final delete boundary', async () => {
    const fixture = destinationBackupCleanupFixture();
    rmSync(fixture.paths.backup, { recursive: true, force: true });
    makePrivateDirectory(fixture.paths.backup);
    const emptyIdentity = verifiedRuntime(fixture.paths.backup).identity;
    const journal = makeFilesystemJournal({
      action: 'owned-slot-cleanup',
      projectRoot: project,
      cleanupSlot: 'destinationBackup',
      destinationManifest: emptyIdentity,
      terminal: fixture.journal.terminal,
    });
    writeArtifactMarker(
      fixture.paths.backupMarker,
      markerForOwnedSlot(
        journal.operationId,
        'destinationBackup',
        'owner',
        emptyIdentity,
        capturePromotionRootIdentity(fixture.paths.backup),
      ),
    );
    const held = `${fixture.paths.backup}.held`;
    let swapped = false;
    const authority = await authorizeFilesystem(
      project,
      'owned-slot-cleanup',
      makeAuthorityHarness(journal),
      {
        cleanupSlot: 'destinationBackup',
        dependencies: {
          checkpoint: (checkpoint) => {
            if (
              !swapped &&
              checkpoint.boundary === 'before' &&
              checkpoint.effect === 'mutation' &&
              checkpoint.operation === 'owned-directory-remove'
            ) {
              swapped = true;
              renameSync(fixture.paths.backup, held);
              makePrivateDirectory(fixture.paths.backup);
            }
          },
        },
      },
    );

    await expect(cleanupRuntimePromotionOwnedSlot(authority)).rejects.toThrow(/replaced/u);
    expect(existsSync(held)).toBe(true);
    expect(existsSync(fixture.paths.backup)).toBe(true);
  });
});
