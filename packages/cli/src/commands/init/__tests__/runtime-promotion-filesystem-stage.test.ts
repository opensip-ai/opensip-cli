import { existsSync, linkSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { inspectRuntimeTree } from '../runtime-manifest-io.js';
import {
  encodeRuntimeStageOwnershipMarker,
  RUNTIME_STAGE_OWNERSHIP_FILE,
} from '../runtime-manifest.js';
import { reconcileRuntimePromotionStage } from '../runtime-promotion-filesystem.js';
import { materializeRuntimeStage } from '../runtime-stage-io.js';
import { createRuntimeStageOwnershipMarker } from '../runtime-stage-ownership.js';

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
import type { RuntimePromotionJournal } from '../runtime-promotion-journal-schema.js';

let sandbox: string;
let project: string;
let parent: string;
let source: string;

beforeEach(() => {
  sandbox = makePrivateDirectory(mkdtempSync(join(tmpdir(), 'opensip-runtime-fs-stage-')));
  project = makePrivateDirectory(join(sandbox, 'project'));
  parent = makePrivateDirectory(join(project, 'opensip-cli'));
  source = makePrivateDirectory(join(sandbox, 'source'));
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

function stageOwnership(journal: RuntimePromotionJournal): RuntimeStageOwnershipIdentity {
  return {
    operationId: journal.operationId,
    stageBasename: journal.owned.runtimeStage.basename,
    ownershipId: journal.owned.runtimeStage.ownershipId,
  };
}

async function reconcile(journal: RuntimePromotionJournal, expected = verifiedRuntime(source)) {
  const authority = await authorizeFilesystem(
    project,
    'runtime-stage-reconcile',
    makeAuthorityHarness(journal),
  );
  return reconcileRuntimePromotionStage(authority, { expected });
}

function stageJournal(): RuntimePromotionJournal {
  const expected = verifiedRuntime(source);
  return makeFilesystemJournal({
    action: 'runtime-stage-reconcile',
    projectRoot: project,
    route: 'promote-cache',
    sourceManifest: expected.identity,
    destinationParentPreexisting: true,
  });
}

describe('runtime stage reconciliation', () => {
  it('reports an absent stage without mutation', async () => {
    const journal = stageJournal();

    await expect(reconcile(journal)).resolves.toEqual({ status: 'absent' });
    expect(existsSync(filesystemPaths(project, journal).stage)).toBe(false);
  });

  it('discards the empty mkdir-only crash intermediate idempotently', async () => {
    const journal = stageJournal();
    const stage = makePrivateDirectory(filesystemPaths(project, journal).stage);

    await expect(reconcile(journal)).resolves.toEqual({
      status: 'discarded-incomplete',
    });
    expect(existsSync(stage)).toBe(false);

    await expect(reconcile(journal)).resolves.toEqual({ status: 'absent' });
  });

  it('discards an exact marker with safe partial files and in-tree links', async () => {
    writePrivateFile(join(source, 'nested', 'evidence.txt'), 'complete-evidence');
    symlinkSync('nested/evidence.txt', join(source, 'evidence-link'));
    const expected = verifiedRuntime(source);
    const journal = makeFilesystemJournal({
      action: 'runtime-stage-reconcile',
      projectRoot: project,
      route: 'promote-cache',
      sourceManifest: expected.identity,
    });
    const stage = makePrivateDirectory(filesystemPaths(project, journal).stage);
    createRuntimeStageOwnershipMarker(stage, stageOwnership(journal));
    makePrivateDirectory(join(stage, 'nested'));
    writePrivateFile(join(stage, 'nested', 'evidence.txt'), 'partial');
    symlinkSync('nested/evidence.txt', join(stage, 'evidence-link'));

    await expect(reconcile(journal, expected)).resolves.toEqual({
      status: 'discarded-incomplete',
    });
    expect(existsSync(stage)).toBe(false);
  });

  it('discards a complete-sized wrong digest from an interrupted owned copy', async () => {
    writePrivateFile(join(source, 'evidence.txt'), 'alpha');
    const expected = verifiedRuntime(source);
    const journal = makeFilesystemJournal({
      action: 'runtime-stage-reconcile',
      projectRoot: project,
      route: 'promote-cache',
      sourceManifest: expected.identity,
    });
    const stage = makePrivateDirectory(filesystemPaths(project, journal).stage);
    createRuntimeStageOwnershipMarker(stage, stageOwnership(journal));
    writePrivateFile(join(stage, 'evidence.txt'), 'omega');

    await expect(reconcile(journal, expected)).resolves.toEqual({
      status: 'discarded-incomplete',
    });
    expect(existsSync(stage)).toBe(false);
  });

  it('recovers a marker-write prefix only when it is the sole child', async () => {
    const journal = stageJournal();
    const stage = makePrivateDirectory(filesystemPaths(project, journal).stage);
    const marker = encodeRuntimeStageOwnershipMarker(stageOwnership(journal));
    writeFileSync(
      join(stage, RUNTIME_STAGE_OWNERSHIP_FILE),
      marker.slice(0, Math.floor(marker.length / 2)),
      { encoding: 'utf8', mode: 0o600 },
    );

    await expect(reconcile(journal)).resolves.toEqual({
      status: 'discarded-incomplete',
    });
    expect(existsSync(stage)).toBe(false);
  });

  it.each(['foreign-entry', 'hard-linked-file'] as const)(
    'rejects ambiguous incomplete ownership: %s',
    async (variant) => {
      writePrivateFile(join(source, 'evidence.txt'), 'expected');
      const expected = verifiedRuntime(source);
      const journal = makeFilesystemJournal({
        action: 'runtime-stage-reconcile',
        projectRoot: project,
        route: 'promote-cache',
        sourceManifest: expected.identity,
      });
      const stage = makePrivateDirectory(filesystemPaths(project, journal).stage);
      createRuntimeStageOwnershipMarker(stage, stageOwnership(journal));
      if (variant === 'foreign-entry') {
        writePrivateFile(join(stage, 'foreign.txt'), 'foreign');
      } else {
        const outside = join(sandbox, 'outside-hard-link');
        writePrivateFile(outside, 'expected');
        linkSync(outside, join(stage, 'evidence.txt'));
      }

      await expect(reconcile(journal, expected)).rejects.toThrow(
        /unowned entry|not operation-owned/u,
      );
      expect(existsSync(stage)).toBe(true);
    },
  );

  it('recognizes a complete journal-owned materialized stage', async () => {
    writePrivateFile(join(source, 'nested', 'evidence.txt'), 'complete');
    const expected = verifiedRuntime(source);
    const journal = makeFilesystemJournal({
      action: 'runtime-stage-reconcile',
      projectRoot: project,
      route: 'promote-cache',
      sourceManifest: expected.identity,
    });
    const ownership = stageOwnership(journal);
    const stage = materializeRuntimeStage(
      source,
      parent,
      journal.owned.runtimeStage.basename,
      inspectRuntimeTree(source, 'project-runtime'),
      ownership,
    );

    const result = await reconcile(journal, expected);
    expect(result.status).toBe('verified');
    expect(existsSync(stage)).toBe(true);
  });
});
