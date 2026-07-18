import {
  existsSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  capturePromotionRootIdentity,
  withStablePromotionDirectory,
} from '../runtime-promotion-filesystem-io.js';
import { markerForOwnedSlot } from '../runtime-promotion-filesystem-marker.js';
import {
  classifyRuntimePromotionPath,
  createRuntimePromotionDestinationParent,
  encodeRuntimePromotionArtifactMarker,
  parseRuntimePromotionArtifactMarker,
  reconcileRuntimePromotionStage,
} from '../runtime-promotion-filesystem.js';
import { captureRuntimePromotionProjectRootAuthority } from '../runtime-promotion-root-authority.js';

import {
  authorizeFilesystem,
  filesystemPaths,
  makeAuthorityHarness,
  makeFilesystemJournal,
  makePrivateDirectory,
  TEST_OPERATION_ID,
  verifiedRuntime,
  writePrivateFile,
} from './runtime-promotion-filesystem-fixture.js';

import type { RuntimePromotionArtifactMarker } from '../runtime-promotion-filesystem.js';

let sandbox: string;
let project: string;

beforeEach(() => {
  sandbox = makePrivateDirectory(mkdtempSync(join(tmpdir(), 'opensip-runtime-fs-authority-')));
  project = makePrivateDirectory(join(sandbox, 'project'));
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe('runtime filesystem authority and root handling', () => {
  it('classifies roots without following links and reports hard-link count', () => {
    const directory = makePrivateDirectory(join(project, 'directory'));
    const file = join(project, 'file');
    const hardLink = join(project, 'hard-link');
    const symlink = join(project, 'directory-link');
    writePrivateFile(file, 'content');
    symlinkSync(directory, symlink);
    linkSync(file, hardLink);

    expect(classifyRuntimePromotionPath(directory)).toMatchObject({
      status: 'directory',
      owner: 'current',
    });
    expect(classifyRuntimePromotionPath(symlink)).toEqual({
      status: 'symlink',
    });
    expect(classifyRuntimePromotionPath(file)).toMatchObject({
      status: 'file',
      links: 2,
    });
    expect(classifyRuntimePromotionPath(join(project, 'absent'))).toEqual({
      status: 'absent',
    });
  });

  it('closes an outer stable descriptor when a nested directory open fails', () => {
    let outerDescriptor: number | undefined;
    expect(() =>
      withStablePromotionDirectory(project, 'the outer directory', (outer) => {
        outerDescriptor = outer.descriptor;
        return withStablePromotionDirectory(
          join(project, 'missing'),
          'the failing nested directory',
          () => undefined,
        );
      }),
    ).toThrow(/could not be opened/u);

    if (outerDescriptor !== undefined) {
      expect(() => fstatSync(outerDescriptor!)).toThrow(expect.objectContaining({ code: 'EBADF' }));
    }
  });

  it('rejects a journal and lease bound to a different canonical project', async () => {
    const otherProject = makePrivateDirectory(join(sandbox, 'other-project'));
    const journal = makeFilesystemJournal({
      action: 'destination-parent-create',
      projectRoot: project,
      destinationParentPreexisting: false,
    });
    const harness = makeAuthorityHarness(journal);

    await expect(
      authorizeFilesystem(otherProject, 'destination-parent-create', harness),
    ).rejects.toThrow(/changed-after-preflight/u);
    expect(existsSync(join(otherProject, 'opensip-cli'))).toBe(false);
    expect(existsSync(filesystemPaths(otherProject, journal).parentMarker)).toBe(false);
  });

  it('rejects a project root replaced after attempt-local authority capture', async () => {
    const journal = makeFilesystemJournal({
      action: 'destination-parent-create',
      projectRoot: project,
      destinationParentPreexisting: false,
    });
    const harness = makeAuthorityHarness(journal);
    const rootAuthority = captureRuntimePromotionProjectRootAuthority({
      lease: harness.lease,
      projectRoot: realpathSync(project),
      expectedPosture: 'normal',
    });
    renameSync(project, `${project}.held`);
    makePrivateDirectory(project);

    await expect(
      authorizeFilesystem(project, 'destination-parent-create', harness, {
        projectRootAuthority: rootAuthority,
      }),
    ).rejects.toThrow(/changed-after-preflight/u);
    expect(existsSync(join(project, 'opensip-cli'))).toBe(false);
    expect(existsSync(filesystemPaths(project, journal).parentMarker)).toBe(false);
  });

  it('issues an exact one-use authority and leaves ownership outside the authored tree', async () => {
    const journal = makeFilesystemJournal({
      action: 'destination-parent-create',
      projectRoot: project,
      destinationParentPreexisting: false,
    });
    const harness = makeAuthorityHarness(journal);
    const authority = await authorizeFilesystem(project, 'destination-parent-create', harness);

    await expect(createRuntimePromotionDestinationParent(authority)).resolves.toEqual({
      status: 'created',
    });
    const paths = filesystemPaths(project, journal);
    expect(existsSync(paths.parentMarker)).toBe(true);
    expect(existsSync(paths.parentStage)).toBe(false);
    if (process.platform !== 'win32') {
      expect(lstatSync(paths.parent).mode & 0o777).toBe(0o755);
    }
    await expect(createRuntimePromotionDestinationParent(authority)).rejects.toThrow(
      /stale or foreign/u,
    );
  });

  it('repairs the exact private-mkdir crash intermediate on retry', async () => {
    const journal = makeFilesystemJournal({
      action: 'destination-parent-create',
      projectRoot: project,
      destinationParentPreexisting: false,
    });
    const paths = filesystemPaths(project, journal);
    const firstHarness = makeAuthorityHarness(journal);
    const first = await authorizeFilesystem(project, 'destination-parent-create', firstHarness, {
      dependencies: {
        checkpoint: (checkpoint) => {
          if (
            checkpoint.boundary === 'before' &&
            checkpoint.effect === 'mutation' &&
            checkpoint.operation === 'destination-parent-chmod'
          ) {
            throw new Error('injected chmod crash');
          }
        },
      },
    });

    await expect(createRuntimePromotionDestinationParent(first)).rejects.toThrow(
      'injected chmod crash',
    );
    expect(existsSync(paths.parentMarker)).toBe(true);
    expect(existsSync(paths.parent)).toBe(false);
    expect(existsSync(paths.parentStage)).toBe(true);
    if (process.platform !== 'win32') {
      expect(lstatSync(paths.parentStage).mode & 0o777).toBe(0o700);
    }

    const retry = await authorizeFilesystem(
      project,
      'destination-parent-create',
      makeAuthorityHarness(journal),
    );
    await expect(createRuntimePromotionDestinationParent(retry)).resolves.toEqual({
      status: 'created',
    });
    if (process.platform !== 'win32') {
      expect(lstatSync(paths.parent).mode & 0o777).toBe(0o755);
    }
  });

  it('does not rebind a partial destination-parent owner to a replacement stage', async () => {
    const journal = makeFilesystemJournal({
      action: 'destination-parent-create',
      projectRoot: project,
      destinationParentPreexisting: false,
    });
    const paths = filesystemPaths(project, journal);
    makePrivateDirectory(paths.parentStage);
    const marker = encodeRuntimePromotionArtifactMarker(
      markerForOwnedSlot(
        journal.operationId,
        'destinationParent',
        'owner',
        null,
        capturePromotionRootIdentity(paths.parentStage),
      ),
    );
    writePrivateFile(paths.parentMarker, marker.slice(0, marker.indexOf('"rootIdentity"')));
    renameSync(paths.parentStage, `${paths.parentStage}.held`);
    makePrivateDirectory(paths.parentStage);
    const authority = await authorizeFilesystem(
      project,
      'destination-parent-create',
      makeAuthorityHarness(journal),
    );

    await expect(createRuntimePromotionDestinationParent(authority)).rejects.toThrow(
      /foreign ownership/u,
    );
    expect(existsSync(paths.parentStage)).toBe(true);
    expect(existsSync(paths.parent)).toBe(false);
  });

  it('does not chmod a symlink target swapped at the before-mutation boundary', async () => {
    if (process.platform === 'win32') return;
    const external = makePrivateDirectory(join(sandbox, 'external'), 0o700);
    const journal = makeFilesystemJournal({
      action: 'destination-parent-create',
      projectRoot: project,
      destinationParentPreexisting: false,
    });
    const paths = filesystemPaths(project, journal);
    const authority = await authorizeFilesystem(
      project,
      'destination-parent-create',
      makeAuthorityHarness(journal),
      {
        dependencies: {
          checkpoint: (checkpoint) => {
            if (
              checkpoint.boundary !== 'before' ||
              checkpoint.effect !== 'mutation' ||
              checkpoint.operation !== 'destination-parent-chmod'
            ) {
              return;
            }
            renameSync(paths.parentStage, `${paths.parentStage}.held`);
            symlinkSync(external, paths.parentStage);
          },
        },
      },
    );

    await expect(createRuntimePromotionDestinationParent(authority)).rejects.toThrow(
      /operation-created directory|replaced/u,
    );
    expect(lstatSync(external).mode & 0o777).toBe(0o700);
    expect(lstatSync(paths.parentStage).isSymbolicLink()).toBe(true);
    expect(existsSync(paths.parent)).toBe(false);
  });

  it('preserves a public replacement created after owner-marker publication', async () => {
    if (process.platform === 'win32') return;
    const journal = makeFilesystemJournal({
      action: 'destination-parent-create',
      projectRoot: project,
      destinationParentPreexisting: false,
    });
    const paths = filesystemPaths(project, journal);
    let swapped = false;
    const first = await authorizeFilesystem(
      project,
      'destination-parent-create',
      makeAuthorityHarness(journal),
      {
        dependencies: {
          checkpoint: (checkpoint) => {
            if (
              swapped ||
              checkpoint.boundary !== 'after' ||
              checkpoint.effect !== 'mutation' ||
              checkpoint.operation !== 'destination-parent-marker-create'
            ) {
              return;
            }
            swapped = true;
            renameSync(paths.parentStage, `${paths.parentStage}.held`);
            makePrivateDirectory(paths.parent, 0o700);
            writePrivateFile(join(paths.parent, 'customer.txt'), 'preserve me');
          },
        },
      },
    );

    await expect(createRuntimePromotionDestinationParent(first)).rejects.toThrow(
      /replaced|disappeared/u,
    );
    const retry = await authorizeFilesystem(
      project,
      'destination-parent-create',
      makeAuthorityHarness(journal),
    );
    await expect(createRuntimePromotionDestinationParent(retry)).rejects.toThrow(
      /exact operation ownership/u,
    );
    expect(readFileSync(join(paths.parent, 'customer.txt'), 'utf8')).toBe('preserve me');
    expect(lstatSync(paths.parent).mode & 0o777).toBe(0o700);
  });

  it('rejects a preexisting destination parent replaced after authorization', async () => {
    const parent = makePrivateDirectory(join(project, 'opensip-cli'), 0o755);
    const source = makePrivateDirectory(join(sandbox, 'source'));
    writePrivateFile(join(source, 'evidence.txt'), 'source');
    const expected = verifiedRuntime(source);
    const journal = makeFilesystemJournal({
      action: 'runtime-stage-reconcile',
      projectRoot: project,
      sourceManifest: expected.identity,
      destinationParentPreexisting: true,
    });
    const paths = filesystemPaths(project, journal);
    const authority = await authorizeFilesystem(
      project,
      'runtime-stage-reconcile',
      makeAuthorityHarness(journal),
    );
    renameSync(parent, `${parent}.held`);
    makePrivateDirectory(parent, 0o755);

    await expect(reconcileRuntimePromotionStage(authority, { expected })).rejects.toThrow(
      /replaced after authorization/u,
    );
    expect(existsSync(paths.stage)).toBe(false);
  });

  it('requires attempt-local parent authority for a journal-preexisting destination', async () => {
    const source = makePrivateDirectory(join(sandbox, 'binding-source'));
    writePrivateFile(join(source, 'evidence.txt'), 'source');
    const expected = verifiedRuntime(source);
    const journal = makeFilesystemJournal({
      action: 'runtime-stage-reconcile',
      projectRoot: project,
      sourceManifest: expected.identity,
      destinationParentPreexisting: true,
    });
    const harness = makeAuthorityHarness(journal);
    const rootAuthority = captureRuntimePromotionProjectRootAuthority({
      lease: harness.lease,
      projectRoot: realpathSync(project),
      expectedPosture: 'normal',
    });
    makePrivateDirectory(join(project, 'opensip-cli'), 0o755);

    await expect(
      authorizeFilesystem(project, 'runtime-stage-reconcile', harness, {
        projectRootAuthority: rootAuthority,
      }),
    ).rejects.toThrow(/lacks attempt-local root authority/u);
  });
});

describe('runtime artifact marker canonical shape', () => {
  it.each([
    {
      name: 'extra key',
      rootIdentity: { device: '1', inode: '2', extra: true },
    },
    {
      name: 'reordered keys',
      rootIdentity: { inode: '2', device: '1' },
    },
    {
      name: 'array',
      rootIdentity: ['1', '2'],
    },
    {
      name: 'wrong field type',
      rootIdentity: { device: 1, inode: '2' },
    },
  ])('rejects a $name in rootIdentity', ({ rootIdentity }) => {
    const runtime = makePrivateDirectory(join(project, 'marker-runtime'));
    writePrivateFile(join(runtime, 'evidence.txt'), 'evidence');
    const identity = verifiedRuntime(runtime).identity;
    const marker = markerForOwnedSlot(TEST_OPERATION_ID, 'runtimeStage', 'cleanup', identity, {
      device: '1',
      inode: '2',
    });
    const canonical = JSON.parse(encodeRuntimePromotionArtifactMarker(marker)) as Record<
      string,
      unknown
    >;
    canonical.rootIdentity = rootIdentity;

    expect(() => parseRuntimePromotionArtifactMarker(JSON.stringify(canonical))).toThrow(
      /root identity/u,
    );
  });

  it('rejects non-closed root identity objects at the encoder boundary', () => {
    const runtime = makePrivateDirectory(join(project, 'encoder-runtime'));
    const identity = verifiedRuntime(runtime).identity;
    const marker = {
      ...markerForOwnedSlot(TEST_OPERATION_ID, 'runtimeStage', 'cleanup', identity, {
        device: '1',
        inode: '2',
      }),
      rootIdentity: { device: '1', inode: '2', extra: 'foreign' },
    } as RuntimePromotionArtifactMarker;

    expect(() => encodeRuntimePromotionArtifactMarker(marker)).toThrow(/root identity/u);
  });
});
