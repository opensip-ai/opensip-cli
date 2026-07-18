import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  EPHEMERAL_MARKER_FILE,
  resolveEphemeralProjectPaths,
  resolveUserPaths,
  touchEphemeralRuntime,
} from '@opensip-cli/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { inspectRuntimeTree } from '../runtime-manifest-io.js';
import { capturePromotionRootIdentity } from '../runtime-promotion-filesystem-io.js';
import { markerForOwnedSlot } from '../runtime-promotion-filesystem-marker.js';
import {
  backupRuntimePromotionDestination,
  cleanupRuntimePromotionOwnedSlot,
  createRuntimePromotionDestinationParent,
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

import type { RuntimeStageOwnershipIdentity } from '../runtime-manifest.js';
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
  sandbox = makePrivateDirectory(mkdtempSync(join(tmpdir(), 'opensip-runtime-fs-lifecycle-')));
  home = makePrivateDirectory(join(sandbox, 'home'));
  project = makePrivateDirectory(join(sandbox, 'project'));
  process.env.HOME = home;
});

afterEach(() => {
  if (priorHome === undefined) delete process.env.HOME;
  else process.env.HOME = priorHome;
  rmSync(sandbox, { recursive: true, force: true });
});

function stageOwnership(journal: RuntimePromotionJournal): RuntimeStageOwnershipIdentity {
  return {
    operationId: journal.operationId,
    stageBasename: journal.owned.runtimeStage.basename,
    ownershipId: journal.owned.runtimeStage.ownershipId,
  };
}

function writeMarker(path: string, marker: ReturnType<typeof markerForOwnedSlot>): void {
  writePrivateFile(path, encodeRuntimePromotionArtifactMarker(marker));
}

function createOwnedParent(journal: RuntimePromotionJournal): ReturnType<typeof filesystemPaths> {
  const paths = filesystemPaths(project, journal);
  makePrivateDirectory(paths.parent, 0o755);
  writeMarker(
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

describe('forward filesystem lifecycle', () => {
  it('backs up a verified destination and replays idempotently', async () => {
    const parent = makePrivateDirectory(join(project, 'opensip-cli'));
    const runtime = makePrivateDirectory(join(parent, '.runtime'));
    writePrivateFile(join(runtime, 'evidence.txt'), 'project-before');
    const expected = verifiedRuntime(runtime);
    const journal = makeFilesystemJournal({
      action: 'destination-backup-create',
      projectRoot: project,
      destinationManifest: expected.identity,
      destinationParentPreexisting: true,
      destinationRuntimePreexisting: true,
    });
    const paths = filesystemPaths(project, journal);

    const first = await authorizeFilesystem(
      project,
      'destination-backup-create',
      makeAuthorityHarness(journal),
    );
    await expect(
      backupRuntimePromotionDestination(first, expected.identity),
    ).resolves.toMatchObject({ status: 'applied' });
    expect(existsSync(paths.runtime)).toBe(false);
    expect(existsSync(paths.backup)).toBe(true);
    expect(existsSync(paths.backupMarker)).toBe(true);

    const retry = await authorizeFilesystem(
      project,
      'destination-backup-create',
      makeAuthorityHarness(journal),
    );
    await expect(
      backupRuntimePromotionDestination(retry, expected.identity),
    ).resolves.toMatchObject({ status: 'already-applied' });
  });

  it.each(['exact', 'partial-before-inode'] as const)(
    'does not grant backup replay authority to an identical replacement with an %s owner marker',
    async (markerPosture) => {
      const parent = makePrivateDirectory(join(project, 'opensip-cli'));
      const runtime = makePrivateDirectory(join(parent, '.runtime'));
      writePrivateFile(join(runtime, 'evidence.txt'), 'project-before');
      const expected = verifiedRuntime(runtime);
      const journal = makeFilesystemJournal({
        action: 'destination-backup-create',
        projectRoot: project,
        destinationManifest: expected.identity,
        destinationParentPreexisting: true,
        destinationRuntimePreexisting: true,
      });
      const paths = filesystemPaths(project, journal);
      const first = await authorizeFilesystem(
        project,
        'destination-backup-create',
        makeAuthorityHarness(journal),
      );
      await backupRuntimePromotionDestination(first, expected.identity);
      const owner = readFileSync(paths.backupMarker, 'utf8');

      rmSync(paths.backup, { recursive: true, force: true });
      makePrivateDirectory(paths.backup);
      writePrivateFile(join(paths.backup, 'evidence.txt'), 'project-before');
      expect(verifiedRuntime(paths.backup).identity).toEqual(expected.identity);
      if (markerPosture === 'partial-before-inode') {
        writePrivateFile(paths.backupMarker, owner.slice(0, owner.indexOf('"rootIdentity"')));
      }
      const retry = await authorizeFilesystem(
        project,
        'destination-backup-create',
        makeAuthorityHarness(journal),
      );

      await expect(backupRuntimePromotionDestination(retry, expected.identity)).rejects.toThrow(
        /owner is absent or foreign/u,
      );
      expect(existsSync(paths.backup)).toBe(true);
      expect(readFileSync(join(paths.backup, 'evidence.txt'), 'utf8')).toBe('project-before');
    },
  );

  it('installs a stage and replays idempotently with retained parent ownership', async () => {
    const source = makePrivateDirectory(join(sandbox, 'install-source'));
    writePrivateFile(join(source, 'evidence.txt'), 'installed');
    const expected = verifiedRuntime(source);
    const journal = makeFilesystemJournal({
      action: 'destination-install',
      projectRoot: project,
      route: 'promote-cache',
      stageManifest: expected.identity,
      destinationParentPreexisting: false,
    });
    const paths = createOwnedParent(journal);
    materializeRuntimeStage(
      source,
      paths.parent,
      journal.owned.runtimeStage.basename,
      inspectRuntimeTree(source, 'project-runtime'),
      stageOwnership(journal),
    );

    const first = await authorizeFilesystem(
      project,
      'destination-install',
      makeAuthorityHarness(journal),
    );
    await expect(installRuntimePromotionStage(first, expected.identity)).resolves.toMatchObject({
      status: 'applied',
    });
    expect(existsSync(paths.parentMarker)).toBe(true);

    const retry = await authorizeFilesystem(
      project,
      'destination-install',
      makeAuthorityHarness(journal),
    );
    await expect(installRuntimePromotionStage(retry, expected.identity)).resolves.toMatchObject({
      status: 'already-applied',
    });
    expect(existsSync(paths.runtime)).toBe(true);
  });

  it('retires cache authority and replays the tombstone postcondition', async () => {
    const cacheKey = '1'.repeat(24);
    const cacheParent = makePrivateDirectory(resolveUserPaths().ephemeralProjectsDir);
    const source = makePrivateDirectory(join(cacheParent, cacheKey));
    writePrivateFile(join(source, 'evidence.txt'), 'promoted');
    const expected = verifiedRuntime(source, 'cache-source');
    const destination = makePrivateDirectory(join(project, 'opensip-cli', '.runtime'));
    writePrivateFile(join(destination, 'evidence.txt'), 'promoted');
    const journal = makeFilesystemJournal({
      action: 'source-retire',
      projectRoot: project,
      route: 'promote-cache',
      source: {
        classification: 'legacy',
        cacheKey,
        generationDigest: null,
        markerSha256: null,
      },
      sourceManifest: expected.identity,
      stageManifest: expected.identity,
    });
    const tombstone = join(cacheParent, journal.owned.sourceTombstone.basename);

    const first = await authorizeFilesystem(
      project,
      'source-retire',
      makeAuthorityHarness(journal),
      { sourceRuntime: realpathSync(source) },
    );
    await expect(retireRuntimePromotionSource(first, expected.identity)).resolves.toMatchObject({
      status: 'applied',
    });
    expect(existsSync(source)).toBe(false);
    expect(existsSync(tombstone)).toBe(true);

    const retry = await authorizeFilesystem(
      project,
      'source-retire',
      makeAuthorityHarness(journal),
      { sourceRuntime: realpathSync(cacheParent) + `/${cacheKey}` },
    );
    await expect(retireRuntimePromotionSource(retry, expected.identity)).resolves.toMatchObject({
      status: 'already-applied',
    });
  });

  it('accepts a cache parent whose lexical path resolves to the anchored cache root', async () => {
    if (process.platform === 'win32') return;
    const homeAlias = join(sandbox, 'home-alias');
    symlinkSync(home, homeAlias, 'dir');
    process.env.HOME = homeAlias;
    const cacheKey = '2'.repeat(24);
    const lexicalCacheParent = makePrivateDirectory(resolveUserPaths().ephemeralProjectsDir);
    const lexicalSource = makePrivateDirectory(join(lexicalCacheParent, cacheKey));
    writePrivateFile(join(lexicalSource, 'evidence.txt'), 'promoted');
    const expected = verifiedRuntime(lexicalSource, 'cache-source');
    const destination = makePrivateDirectory(join(project, 'opensip-cli', '.runtime'));
    writePrivateFile(join(destination, 'evidence.txt'), 'promoted');
    const journal = makeFilesystemJournal({
      action: 'source-retire',
      projectRoot: project,
      route: 'promote-cache',
      source: {
        classification: 'legacy',
        cacheKey,
        generationDigest: null,
        markerSha256: null,
      },
      sourceManifest: expected.identity,
      stageManifest: expected.identity,
    });

    const authority = await authorizeFilesystem(
      project,
      'source-retire',
      makeAuthorityHarness(journal),
      { sourceRuntime: lexicalSource },
    );
    await expect(retireRuntimePromotionSource(authority, expected.identity)).resolves.toMatchObject(
      { status: 'applied' },
    );
    expect(existsSync(lexicalSource)).toBe(false);
  });

  it('retires a generation-bound cache only while its marker proof is exact', async () => {
    const cache = resolveEphemeralProjectPaths(project);
    if (cache.generationDigest === undefined) {
      throw new Error('test project did not produce generation-bound identity');
    }
    touchEphemeralRuntime(cache, Date.parse('2026-07-17T12:00:00.000Z'));
    writePrivateFile(join(cache.runtimeDir, 'evidence.txt'), 'generation-bound');
    const expected = verifiedRuntime(cache.runtimeDir, 'cache-source');
    const markerSha256 = createHash('sha256')
      .update(readFileSync(join(cache.runtimeDir, EPHEMERAL_MARKER_FILE)))
      .digest('hex');
    const destination = makePrivateDirectory(join(project, 'opensip-cli', '.runtime'));
    writePrivateFile(join(destination, 'evidence.txt'), 'generation-bound');
    const journal = makeFilesystemJournal({
      action: 'source-retire',
      projectRoot: project,
      route: 'promote-cache',
      source: {
        classification: 'generation-bound',
        cacheKey: cache.cacheKey,
        generationDigest: cache.generationDigest,
        markerSha256,
      },
      sourceManifest: expected.identity,
      stageManifest: expected.identity,
    });
    const authority = await authorizeFilesystem(
      project,
      'source-retire',
      makeAuthorityHarness(journal),
      { sourceRuntime: realpathSync(cache.runtimeDir) },
    );

    await expect(retireRuntimePromotionSource(authority, expected.identity)).resolves.toMatchObject(
      { status: 'applied' },
    );
  });

  it("rejects a matching cache basename outside Core's anchored cache root", async () => {
    const cacheKey = '3'.repeat(24);
    makePrivateDirectory(resolveUserPaths().ephemeralProjectsDir);
    const foreign = makePrivateDirectory(join(sandbox, 'foreign-cache-parent', cacheKey));
    writePrivateFile(join(foreign, 'evidence.txt'), 'foreign');
    const expected = verifiedRuntime(foreign, 'cache-source');
    const journal = makeFilesystemJournal({
      action: 'source-retire',
      projectRoot: project,
      route: 'promote-cache',
      source: {
        classification: 'legacy',
        cacheKey,
        generationDigest: null,
        markerSha256: null,
      },
      sourceManifest: expected.identity,
      stageManifest: expected.identity,
    });

    await expect(
      authorizeFilesystem(project, 'source-retire', makeAuthorityHarness(journal), {
        sourceRuntime: realpathSync(foreign),
      }),
    ).rejects.toThrow(/not anchored/u);
    expect(existsSync(foreign)).toBe(true);
  });
});

describe('rollback filesystem lifecycle', () => {
  it('removes the private destination-parent stage from a preinstall crash', async () => {
    const createJournal = makeFilesystemJournal({
      action: 'destination-parent-create',
      projectRoot: project,
      destinationParentPreexisting: false,
    });
    const paths = filesystemPaths(project, createJournal);
    const createAuthority = await authorizeFilesystem(
      project,
      'destination-parent-create',
      makeAuthorityHarness(createJournal),
      {
        dependencies: {
          checkpoint: (checkpoint) => {
            if (
              checkpoint.boundary === 'before' &&
              checkpoint.effect === 'mutation' &&
              checkpoint.operation === 'destination-parent-chmod'
            ) {
              throw new Error('injected preinstall crash');
            }
          },
        },
      },
    );
    await expect(createRuntimePromotionDestinationParent(createAuthority)).rejects.toThrow(
      'injected preinstall crash',
    );
    expect(existsSync(paths.parent)).toBe(false);
    expect(existsSync(paths.parentStage)).toBe(true);
    expect(existsSync(paths.parentMarker)).toBe(true);

    const rollbackJournal = makeFilesystemJournal({
      action: 'runtime-rollback',
      projectRoot: project,
      destinationParentPreexisting: false,
      runtimeInstallState: 'not-installed',
    });
    const rollbackAuthority = await authorizeFilesystem(
      project,
      'runtime-rollback',
      makeAuthorityHarness(rollbackJournal),
    );
    await expect(
      rollbackRuntimePromotion(rollbackAuthority, {
        installed: null,
        backup: null,
        installedWasAuthoritative: false,
      }),
    ).resolves.toMatchObject({ status: 'rolled-back' });
    expect(existsSync(paths.parentStage)).toBe(false);
    expect(existsSync(paths.parentMarker)).toBe(false);
  });

  it('removes an installed candidate, restores its backup, and replays', async () => {
    const parent = makePrivateDirectory(join(project, 'opensip-cli'));
    const runtime = makePrivateDirectory(join(parent, '.runtime'));
    writePrivateFile(join(runtime, 'evidence.txt'), 'installed-new');
    const installed = verifiedRuntime(runtime);
    const provisional = makeFilesystemJournal({
      action: 'runtime-rollback',
      projectRoot: project,
      destinationParentPreexisting: true,
      destinationRuntimePreexisting: true,
      runtimeInstallState: 'installed',
    });
    const paths = filesystemPaths(project, provisional);
    const backup = makePrivateDirectory(paths.backup);
    writePrivateFile(join(backup, 'evidence.txt'), 'restored-old');
    const previous = verifiedRuntime(backup);
    const journal = makeFilesystemJournal({
      action: 'runtime-rollback',
      projectRoot: project,
      destinationParentPreexisting: true,
      destinationRuntimePreexisting: true,
      runtimeInstallState: 'installed',
      stageManifest: installed.identity,
      destinationManifest: previous.identity,
    });
    writeMarker(
      paths.backupMarker,
      markerForOwnedSlot(
        journal.operationId,
        'destinationBackup',
        'owner',
        previous.identity,
        capturePromotionRootIdentity(backup),
      ),
    );

    const first = await authorizeFilesystem(
      project,
      'runtime-rollback',
      makeAuthorityHarness(journal),
    );
    await expect(
      rollbackRuntimePromotion(first, {
        installed: installed.identity,
        backup: previous.identity,
        installedWasAuthoritative: true,
      }),
    ).resolves.toMatchObject({
      status: 'rolled-back',
      runtimeInstallState: 'rolled-back',
    });
    expect(verifiedRuntime(paths.runtime).identity).toEqual(previous.identity);
    expect(existsSync(paths.backup)).toBe(false);

    const retry = await authorizeFilesystem(
      project,
      'runtime-rollback',
      makeAuthorityHarness(journal),
    );
    await expect(
      rollbackRuntimePromotion(retry, {
        installed: installed.identity,
        backup: previous.identity,
        installedWasAuthoritative: true,
      }),
    ).resolves.toMatchObject({ status: 'already-rolled-back' });
  });

  it('does not restore an identical backup replacement with a foreign inode', async () => {
    const parent = makePrivateDirectory(join(project, 'opensip-cli'));
    const runtime = makePrivateDirectory(join(parent, '.runtime'));
    writePrivateFile(join(runtime, 'evidence.txt'), 'installed-new');
    const installed = verifiedRuntime(runtime);
    const provisional = makeFilesystemJournal({
      action: 'runtime-rollback',
      projectRoot: project,
      destinationParentPreexisting: true,
      destinationRuntimePreexisting: true,
      runtimeInstallState: 'installed',
    });
    const paths = filesystemPaths(project, provisional);
    const backup = makePrivateDirectory(paths.backup);
    writePrivateFile(join(backup, 'evidence.txt'), 'restored-old');
    const previous = verifiedRuntime(backup);
    const journal = makeFilesystemJournal({
      action: 'runtime-rollback',
      projectRoot: project,
      destinationParentPreexisting: true,
      destinationRuntimePreexisting: true,
      runtimeInstallState: 'installed',
      stageManifest: installed.identity,
      destinationManifest: previous.identity,
    });
    writeMarker(
      paths.backupMarker,
      markerForOwnedSlot(
        journal.operationId,
        'destinationBackup',
        'owner',
        previous.identity,
        capturePromotionRootIdentity(backup),
      ),
    );
    rmSync(backup, { recursive: true, force: true });
    makePrivateDirectory(backup);
    writePrivateFile(join(backup, 'evidence.txt'), 'restored-old');
    expect(verifiedRuntime(backup).identity).toEqual(previous.identity);
    const authority = await authorizeFilesystem(
      project,
      'runtime-rollback',
      makeAuthorityHarness(journal),
    );

    await expect(
      rollbackRuntimePromotion(authority, {
        installed: installed.identity,
        backup: previous.identity,
        installedWasAuthoritative: true,
      }),
    ).rejects.toThrow(/backup owner is absent or foreign/u);
    expect(existsSync(backup)).toBe(true);
    expect(readFileSync(join(backup, 'evidence.txt'), 'utf8')).toBe('restored-old');
  });

  it('removes a created parent and owned stage in the preinstall window', async () => {
    const source = makePrivateDirectory(join(sandbox, 'preinstall-source'));
    writePrivateFile(join(source, 'evidence.txt'), 'staged');
    const staged = verifiedRuntime(source);
    const journal = makeFilesystemJournal({
      action: 'runtime-rollback',
      projectRoot: project,
      route: 'promote-cache',
      destinationParentPreexisting: false,
      runtimeInstallState: 'not-installed',
      stageManifest: staged.identity,
    });
    const paths = createOwnedParent(journal);
    materializeRuntimeStage(
      source,
      paths.parent,
      journal.owned.runtimeStage.basename,
      inspectRuntimeTree(source, 'project-runtime'),
      stageOwnership(journal),
    );

    const first = await authorizeFilesystem(
      project,
      'runtime-rollback',
      makeAuthorityHarness(journal),
    );
    await expect(
      rollbackRuntimePromotion(first, {
        installed: staged.identity,
        backup: null,
        installedWasAuthoritative: false,
      }),
    ).resolves.toMatchObject({ status: 'rolled-back' });
    expect(existsSync(paths.parent)).toBe(false);
    expect(existsSync(paths.parentMarker)).toBe(false);

    const retry = await authorizeFilesystem(
      project,
      'runtime-rollback',
      makeAuthorityHarness(journal),
    );
    await expect(
      rollbackRuntimePromotion(retry, {
        installed: staged.identity,
        backup: null,
        installedWasAuthoritative: false,
      }),
    ).resolves.toMatchObject({ status: 'already-rolled-back' });
  });

  it('removes an owned preinstall stage while preserving a preexisting parent', async () => {
    const parent = makePrivateDirectory(join(project, 'opensip-cli'));
    const source = makePrivateDirectory(join(sandbox, 'preexisting-parent-stage-source'));
    writePrivateFile(join(source, 'evidence.txt'), 'staged');
    const staged = verifiedRuntime(source);
    const journal = makeFilesystemJournal({
      action: 'runtime-rollback',
      projectRoot: project,
      route: 'promote-cache',
      destinationParentPreexisting: true,
      runtimeInstallState: 'not-installed',
      stageManifest: staged.identity,
      runtimeStageCleanup: 'pending',
    });
    const paths = filesystemPaths(project, journal);
    materializeRuntimeStage(
      source,
      parent,
      journal.owned.runtimeStage.basename,
      inspectRuntimeTree(source, 'project-runtime'),
      stageOwnership(journal),
    );

    const first = await authorizeFilesystem(
      project,
      'runtime-rollback',
      makeAuthorityHarness(journal),
    );
    await expect(
      rollbackRuntimePromotion(first, {
        installed: staged.identity,
        backup: null,
        installedWasAuthoritative: false,
      }),
    ).resolves.toMatchObject({ status: 'rolled-back' });
    expect(existsSync(paths.stage)).toBe(false);
    expect(existsSync(parent)).toBe(true);

    const retry = await authorizeFilesystem(
      project,
      'runtime-rollback',
      makeAuthorityHarness(journal),
    );
    await expect(
      rollbackRuntimePromotion(retry, {
        installed: staged.identity,
        backup: null,
        installedWasAuthoritative: false,
      }),
    ).resolves.toMatchObject({ status: 'already-rolled-back' });
  });
});

interface CleanupSetup {
  readonly journal: RuntimePromotionJournal;
  readonly paths: ReturnType<typeof filesystemPaths>;
  readonly backupIdentity: RuntimeManifestIdentity;
}

function backupCleanupSetup(): CleanupSetup {
  const parent = makePrivateDirectory(join(project, 'opensip-cli'));
  const current = makePrivateDirectory(join(parent, '.runtime'));
  writePrivateFile(join(current, 'current.txt'), 'current');
  const currentManifest = verifiedRuntime(current);
  const provisional = makeFilesystemJournal({
    action: 'owned-slot-cleanup',
    projectRoot: project,
    cleanupSlot: 'destinationBackup',
  });
  const paths = filesystemPaths(project, provisional);
  const backup = makePrivateDirectory(paths.backup);
  writePrivateFile(join(backup, 'old.txt'), 'old');
  const backupIdentity = verifiedRuntime(backup).identity;
  const journal = makeFilesystemJournal({
    action: 'owned-slot-cleanup',
    projectRoot: project,
    cleanupSlot: 'destinationBackup',
    destinationManifest: backupIdentity,
    terminal: committedTerminal(currentManifest.identity),
  });
  writeMarker(
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

describe('terminal cleanup lifecycle', () => {
  it('cleans a complete leftover runtime stage and replays', async () => {
    const source = makePrivateDirectory(join(sandbox, 'cleanup-stage-source'));
    writePrivateFile(join(source, 'evidence.txt'), 'staged-leftover');
    const expected = verifiedRuntime(source);
    const current = makePrivateDirectory(join(project, 'opensip-cli', '.runtime'));
    writePrivateFile(join(current, 'evidence.txt'), 'current-authority');
    const currentManifest = verifiedRuntime(current);
    const journal = makeFilesystemJournal({
      action: 'owned-slot-cleanup',
      projectRoot: project,
      route: 'project-authority',
      destinationParentPreexisting: true,
      destinationRuntimePreexisting: true,
      cleanupSlot: 'runtimeStage',
      stageManifest: expected.identity,
      terminal: committedTerminal(currentManifest.identity),
    });
    const paths = filesystemPaths(project, journal);
    materializeRuntimeStage(
      source,
      paths.parent,
      journal.owned.runtimeStage.basename,
      inspectRuntimeTree(source, 'project-runtime'),
      stageOwnership(journal),
    );

    const first = await authorizeFilesystem(
      project,
      'owned-slot-cleanup',
      makeAuthorityHarness(journal),
      { cleanupSlot: 'runtimeStage' },
    );
    await expect(cleanupRuntimePromotionOwnedSlot(first)).resolves.toEqual({
      slot: 'runtimeStage',
      status: 'removed',
    });
    expect(existsSync(paths.stage)).toBe(false);

    const retry = await authorizeFilesystem(
      project,
      'owned-slot-cleanup',
      makeAuthorityHarness(journal),
      { cleanupSlot: 'runtimeStage' },
    );
    await expect(cleanupRuntimePromotionOwnedSlot(retry)).resolves.toEqual({
      slot: 'runtimeStage',
      status: 'already-absent',
    });
  });

  it('removes only the external destination-parent marker at terminal cleanup', async () => {
    const journal = makeFilesystemJournal({
      action: 'owned-slot-cleanup',
      projectRoot: project,
      cleanupSlot: 'destinationParent',
      destinationParentPreexisting: false,
    });
    const paths = createOwnedParent(journal);
    const authority = await authorizeFilesystem(
      project,
      'owned-slot-cleanup',
      makeAuthorityHarness(journal),
      { cleanupSlot: 'destinationParent' },
    );

    await expect(cleanupRuntimePromotionOwnedSlot(authority)).resolves.toEqual({
      slot: 'destinationParent',
      status: 'removed',
    });
    expect(existsSync(paths.parent)).toBe(true);
    expect(existsSync(paths.parentMarker)).toBe(false);
  });

  it('resumes an exact cleanup marker without following a replacement link', async () => {
    const setup = backupCleanupSetup();
    const external = join(sandbox, 'external-evidence.txt');
    writePrivateFile(external, 'must-survive');
    const cleanupMarker = join(
      setup.paths.parent,
      runtimePromotionCleanupMarkerBasename(setup.journal.owned.destinationBackup.basename),
    );
    const rootIdentity = capturePromotionRootIdentity(setup.paths.backup);
    writeMarker(
      cleanupMarker,
      markerForOwnedSlot(
        setup.journal.operationId,
        'destinationBackup',
        'cleanup',
        setup.backupIdentity,
        rootIdentity,
      ),
    );
    unlinkSync(join(setup.paths.backup, 'old.txt'));
    symlinkSync(external, join(setup.paths.backup, 'old.txt'));
    rmSync(setup.paths.runtime, { recursive: true, force: true });
    const authority = await authorizeFilesystem(
      project,
      'owned-slot-cleanup',
      makeAuthorityHarness(setup.journal),
      { cleanupSlot: 'destinationBackup' },
    );

    await expect(cleanupRuntimePromotionOwnedSlot(authority)).resolves.toEqual({
      slot: 'destinationBackup',
      status: 'removed',
    });
    expect(existsSync(external)).toBe(true);
    expect(existsSync(setup.paths.backup)).toBe(false);
    expect(existsSync(cleanupMarker)).toBe(false);
  });

  it.each(['missing', 'symlink'] as const)(
    'preserves the owner tree when the current successor is %s',
    async (posture) => {
      const setup = backupCleanupSetup();
      rmSync(setup.paths.runtime, { recursive: true, force: true });
      if (posture === 'symlink') {
        const external = makePrivateDirectory(join(sandbox, 'external-runtime'));
        symlinkSync(external, setup.paths.runtime);
      }
      const cleanupMarker = join(
        setup.paths.parent,
        runtimePromotionCleanupMarkerBasename(setup.journal.owned.destinationBackup.basename),
      );
      const authority = await authorizeFilesystem(
        project,
        'owned-slot-cleanup',
        makeAuthorityHarness(setup.journal),
        { cleanupSlot: 'destinationBackup' },
      );

      await expect(cleanupRuntimePromotionOwnedSlot(authority)).rejects.toThrow();
      expect(existsSync(setup.paths.backup)).toBe(true);
      expect(existsSync(setup.paths.backupMarker)).toBe(true);
      expect(existsSync(cleanupMarker)).toBe(false);
    },
  );

  it('removes a source tombstone after proving a valid current successor', async () => {
    const cacheKey = '2'.repeat(24);
    const cacheParent = makePrivateDirectory(resolveUserPaths().ephemeralProjectsDir);
    const current = makePrivateDirectory(join(project, 'opensip-cli', '.runtime'));
    writePrivateFile(join(current, 'current.txt'), 'current');
    const currentManifest = verifiedRuntime(current);
    const provisional = makeFilesystemJournal({
      action: 'owned-slot-cleanup',
      projectRoot: project,
      route: 'promote-cache',
      source: {
        classification: 'legacy',
        cacheKey,
        generationDigest: null,
        markerSha256: null,
      },
      cleanupSlot: 'sourceTombstone',
    });
    const tombstone = makePrivateDirectory(
      join(cacheParent, provisional.owned.sourceTombstone.basename),
    );
    writePrivateFile(join(tombstone, 'old.txt'), 'old-cache');
    const tombstoneIdentity = verifiedRuntime(tombstone, 'cache-source').identity;
    const journal = makeFilesystemJournal({
      action: 'owned-slot-cleanup',
      projectRoot: project,
      route: 'promote-cache',
      source: {
        classification: 'legacy',
        cacheKey,
        generationDigest: null,
        markerSha256: null,
      },
      cleanupSlot: 'sourceTombstone',
      sourceManifest: tombstoneIdentity,
      terminal: committedTerminal(currentManifest.identity),
    });
    const ownerPath = join(
      cacheParent,
      runtimePromotionOwnerMarkerBasename(journal.owned.sourceTombstone.basename),
    );
    writeMarker(
      ownerPath,
      markerForOwnedSlot(
        journal.operationId,
        'sourceTombstone',
        'owner',
        tombstoneIdentity,
        capturePromotionRootIdentity(tombstone),
      ),
    );
    const authority = await authorizeFilesystem(
      project,
      'owned-slot-cleanup',
      makeAuthorityHarness(journal),
      {
        cleanupSlot: 'sourceTombstone',
        sourceRuntime: join(realpathSync(cacheParent), cacheKey),
      },
    );

    await expect(cleanupRuntimePromotionOwnedSlot(authority)).resolves.toEqual({
      slot: 'sourceTombstone',
      status: 'removed',
    });
    expect(existsSync(tombstone)).toBe(false);
    expect(existsSync(ownerPath)).toBe(false);
  });
});
