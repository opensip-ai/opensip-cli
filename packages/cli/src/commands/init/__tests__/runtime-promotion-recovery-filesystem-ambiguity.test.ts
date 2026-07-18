import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  acquireRuntimeExclusiveLease,
  inspectRuntimePromotionRecoveryHeader,
  readRuntimePromotionJournal,
  resolveUserPaths,
  type RuntimeExclusiveLease,
} from '@opensip-cli/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  recordOpenIntent,
  recordOpenPostcondition,
} from '../authored-state-transaction-journal.js';
import {
  copyRuntimeToStage,
  inspectVerifiedRuntimeManifest,
  RUNTIME_STAGE_OWNERSHIP_FILE,
} from '../runtime-manifest.js';
import { capturePromotionRootIdentity } from '../runtime-promotion-filesystem-io.js';
import {
  encodeRuntimePromotionArtifactMarker,
  markerForOwnedSlot,
} from '../runtime-promotion-filesystem-marker.js';
import {
  createInitialRuntimePromotionJournal,
  createRuntimePromotionOwnedSlots,
  parseRuntimePromotionJournal,
  type RuntimePromotionJournal,
  type RuntimePromotionPendingIntent,
} from '../runtime-promotion-journal-schema.js';
import {
  createRuntimePromotionJournalController,
  type DurableOpenPromotionJournal,
} from '../runtime-promotion-journal.js';
import { recoverRuntimePromotion } from '../runtime-promotion-recovery.js';
import { captureRuntimePromotionProjectRootAuthority } from '../runtime-promotion-root-authority.js';
import { createRuntimePromotionTransitionWriter } from '../runtime-promotion-transitions.js';

import {
  filesystemPaths,
  makePrivateDirectory,
  writePrivateFile,
} from './runtime-promotion-filesystem-fixture.js';

const DATASTORE_LOCK_CONTEXT = {
  policy: { waitMs: 1000, staleMs: 30_000, heartbeatMs: 1000 },
  command: 'opensip init recovery ambiguity test',
  cwdBasename: 'project',
} as const;
const AUTHORED_DIGEST = 'a'.repeat(64);
const REPLAY_DIGEST = 'b'.repeat(64);
const SOURCE_CONTENT = 'selected cache authority';
const DESTINATION_CONTENT = 'preexisting project authority';

type RenameIntent = 'destination-backup-create' | 'destination-install';
type AmbiguityWindow = 'both' | 'neither';

interface PendingRenameFixture {
  readonly operationId: string;
  readonly pendingIntent: RuntimePromotionPendingIntent;
  readonly journal: RuntimePromotionJournal;
  readonly paths: ReturnType<typeof filesystemPaths>;
  readonly sourceRuntime: string;
}

interface DirectoryRootSnapshot {
  readonly dev: string;
  readonly ino: string;
  readonly uid: string;
  readonly mode: string;
  readonly nlink: string;
}

let sandbox: string;
let home: string;
let project: string;
let priorHome: string | undefined;

function seedRuntime(path: string, content: string): string {
  makePrivateDirectory(path);
  writePrivateFile(join(path, 'evidence.txt'), content);
  return path;
}

function rootSnapshot(path: string): DirectoryRootSnapshot {
  const stat = lstatSync(path, { bigint: true });
  return {
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    uid: stat.uid.toString(),
    mode: stat.mode.toString(),
    nlink: stat.nlink.toString(),
  };
}

function projectRuntimeSnapshot(path: string) {
  return {
    root: rootSnapshot(path),
    manifest: inspectVerifiedRuntimeManifest(path, 'project-runtime'),
    evidence: readFileSync(join(path, 'evidence.txt'), 'utf8'),
  };
}

function cacheRuntimeSnapshot(path: string) {
  return {
    root: rootSnapshot(path),
    manifest: inspectVerifiedRuntimeManifest(path, 'cache-source'),
    evidence: readFileSync(join(path, 'evidence.txt'), 'utf8'),
  };
}

function stageOwnership(journal: RuntimePromotionJournal): {
  readonly operationId: string;
  readonly stageBasename: string;
  readonly ownershipId: string;
} {
  return {
    operationId: journal.operationId,
    stageBasename: journal.owned.runtimeStage.basename,
    ownershipId: journal.owned.runtimeStage.ownershipId,
  };
}

function stageSnapshot(path: string, journal: RuntimePromotionJournal) {
  return {
    root: rootSnapshot(path),
    manifest: inspectVerifiedRuntimeManifest(path, 'promotion-stage', {}, stageOwnership(journal)),
    marker: readFileSync(join(path, RUNTIME_STAGE_OWNERSHIP_FILE), 'utf8'),
    evidence: readFileSync(join(path, 'evidence.txt'), 'utf8'),
  };
}

function privateLease(
  posture: 'normal' | 'init-recovery',
  operationId?: string,
): Promise<RuntimeExclusiveLease> {
  return acquireRuntimeExclusiveLease({
    projectDir: project,
    posture,
    ...(operationId === undefined ? {} : { recoveryOperationId: operationId }),
    command: 'runtime promotion recovery ambiguity test',
    cwdBasename: 'project',
  });
}

async function advanceToRuntimeStaged(input: {
  readonly lease: RuntimeExclusiveLease;
  readonly sourceRuntime: string;
  readonly destinationManifest: RuntimePromotionJournal['manifests']['destination'];
}): Promise<{
  readonly controller: ReturnType<typeof createRuntimePromotionJournalController>;
  readonly writer: ReturnType<typeof createRuntimePromotionTransitionWriter>;
  readonly receipt: DurableOpenPromotionJournal;
}> {
  const source = inspectVerifiedRuntimeManifest(input.sourceRuntime, 'cache-source');
  const controller = createRuntimePromotionJournalController(input.lease);
  const writer = createRuntimePromotionTransitionWriter(controller);
  const allocation = controller.allocate((identity) =>
    createInitialRuntimePromotionJournal({
      coordinationKey: input.lease.coordinationKey,
      operationId: identity.operationId,
      recoveryOwnerToken: identity.recoveryOwnerToken,
      route: 'promote-cache',
      destinationParentPreexisting: true,
      destinationRuntimePreexisting: input.destinationManifest !== null,
      source: {
        classification: 'legacy',
        cacheKey: input.lease.coordinationKey,
        generationDigest: null,
        markerSha256: source.identity.digest,
      },
      inputs: {
        conflict: 'use-cache',
        authoredMode: 'fresh',
        languages: ['typescript'],
        languageExplicit: false,
      },
      plan: {
        authoredDigest: AUTHORED_DIGEST,
        replayDigest: REPLAY_DIGEST,
        mutationCount: 0,
      },
      owned: createRuntimePromotionOwnedSlots(identity.operationId),
      createdAt: identity.createdAt,
    }),
  );
  let receipt = await controller.create(allocation);
  receipt = await writer.verifySource(receipt, source.identity);
  receipt = await writer.verifyDestination(receipt, input.destinationManifest);
  receipt = await recordOpenIntent(
    controller,
    receipt,
    'authored-prepare',
    'authoredStage',
    null,
    Date.now,
  );
  receipt = await recordOpenPostcondition(
    controller,
    receipt,
    {
      phase: 'authored-prepared',
      outcome: 'applied',
      prepareArtifacts: true,
    },
    Date.now,
  );
  receipt = await writer.advancePreexistingDestinationReady(receipt);
  receipt = await writer.recordRuntimeStageCreateIntent(receipt);

  const intent = await controller.verifyOpen(receipt);
  const copied = await copyRuntimeToStage({
    controller,
    receipt,
    sourceDir: input.sourceRuntime,
    sourcePosture: 'cache-source',
    destinationParent: join(project, 'opensip-cli'),
    stageBasename: intent.owned.runtimeStage.basename,
    projectRootAuthority: captureRuntimePromotionProjectRootAuthority({
      lease: input.lease,
      projectRoot: project,
      expectedPosture: 'normal',
    }),
    lease: input.lease,
  });
  receipt = await writer.recordRuntimeStaged(receipt, 'applied', copied.stage.identity);
  return { controller, writer, receipt };
}

async function createPendingRenameFixture(
  intent: RenameIntent,
  window: AmbiguityWindow,
): Promise<PendingRenameFixture> {
  makePrivateDirectory(join(project, 'opensip-cli'), 0o755);
  const destinationRuntime = join(project, 'opensip-cli', '.runtime');
  const destinationManifest =
    intent === 'destination-backup-create'
      ? inspectVerifiedRuntimeManifest(
          seedRuntime(destinationRuntime, DESTINATION_CONTENT),
          'project-runtime',
        ).identity
      : null;
  const lease = await privateLease('normal');
  try {
    const sourceRuntime = realpathSync(
      seedRuntime(
        join(resolveUserPaths().ephemeralProjectsDir, lease.coordinationKey),
        SOURCE_CONTENT,
      ),
    );
    const staged = await advanceToRuntimeStaged({
      lease,
      sourceRuntime,
      destinationManifest,
    });
    const receipt =
      intent === 'destination-backup-create'
        ? await staged.writer.recordDestinationBackupCreateIntent(staged.receipt)
        : await staged.writer.recordDestinationInstallIntent(staged.receipt);
    const journal = await staged.controller.verifyOpen(receipt);
    const paths = filesystemPaths(project, journal);

    if (intent === 'destination-backup-create') {
      if (destinationManifest === null) {
        throw new Error('backup ambiguity fixture lacks its destination manifest');
      }
      if (window === 'both') {
        seedRuntime(paths.backup, DESTINATION_CONTENT);
        expect(inspectVerifiedRuntimeManifest(paths.backup, 'project-runtime').identity).toEqual(
          destinationManifest,
        );
        writePrivateFile(
          paths.backupMarker,
          encodeRuntimePromotionArtifactMarker(
            markerForOwnedSlot(
              journal.operationId,
              'destinationBackup',
              'owner',
              destinationManifest,
              capturePromotionRootIdentity(paths.backup),
            ),
          ),
        );
      } else {
        rmSync(paths.runtime, { recursive: true, force: true });
      }
    } else if (window === 'both') {
      seedRuntime(paths.runtime, SOURCE_CONTENT);
      expect(inspectVerifiedRuntimeManifest(paths.runtime, 'project-runtime').identity).toEqual(
        journal.manifests.runtimeStage,
      );
    } else {
      rmSync(paths.stage, { recursive: true, force: true });
    }

    const pendingIntent = journal.progress.pendingIntent;
    if (pendingIntent?.kind !== intent) {
      throw new Error(`fixture did not retain its ${intent} intent`);
    }
    return {
      operationId: journal.operationId,
      pendingIntent,
      journal,
      paths,
      sourceRuntime,
    };
  } finally {
    lease.release();
  }
}

async function readOpenJournal(operationId: string): Promise<RuntimePromotionJournal> {
  const header = inspectRuntimePromotionRecoveryHeader(project);
  if (header.status !== 'valid' || header.operationId !== operationId) {
    throw new Error('expected the same valid recovery journal header');
  }
  const lease = await privateLease('init-recovery', operationId);
  try {
    const record = await readRuntimePromotionJournal(lease);
    if (record.status !== 'present') throw new Error('expected the recovery journal to remain');
    return parseRuntimePromotionJournal(record.content);
  } finally {
    lease.release();
  }
}

async function expectAmbiguousRecovery(fixture: PendingRenameFixture): Promise<void> {
  // No dependency overrides: this exercises the production journal, authority,
  // lease, and filesystem reconciliation paths against the real candidates.
  await expect(
    recoverRuntimePromotion({
      projectRoot: project,
      datastoreLockContext: DATASTORE_LOCK_CONTEXT,
    }),
  ).resolves.toMatchObject({
    status: 'recovery-required',
    reasonCode: 'artifact-mismatch',
    nextCommand: 'opensip init',
  });

  const journal = await readOpenJournal(fixture.operationId);
  expect(journal).toMatchObject({
    state: 'open',
    operationId: fixture.operationId,
    progress: {
      phase: 'runtime-staged',
      pendingIntent: fixture.pendingIntent,
    },
  });
  expect(journal.progress.pendingIntent).toEqual(fixture.pendingIntent);
  expect(journal.counts.intentCount).toBe(fixture.journal.counts.intentCount);
}

beforeEach(() => {
  priorHome = process.env.HOME;
  sandbox = realpathSync(
    makePrivateDirectory(mkdtempSync(join(tmpdir(), 'opensip-recovery-ambiguity-'))),
  );
  home = makePrivateDirectory(join(sandbox, 'home'));
  project = realpathSync(makePrivateDirectory(join(sandbox, 'project')));
  process.env.HOME = home;
});

afterEach(() => {
  if (priorHome === undefined) delete process.env.HOME;
  else process.env.HOME = priorHome;
  rmSync(sandbox, { recursive: true, force: true });
});

describe('runtime promotion recovery filesystem ambiguity', () => {
  it('keeps a backup intent open when destination and backup are both present', async () => {
    const fixture = await createPendingRenameFixture('destination-backup-create', 'both');
    const parentEntries = readdirSync(dirname(fixture.paths.runtime)).sort();
    const source = cacheRuntimeSnapshot(fixture.sourceRuntime);
    const stage = stageSnapshot(fixture.paths.stage, fixture.journal);
    const destination = projectRuntimeSnapshot(fixture.paths.runtime);
    const backup = projectRuntimeSnapshot(fixture.paths.backup);
    const backupMarker = readFileSync(fixture.paths.backupMarker, 'utf8');

    await expectAmbiguousRecovery(fixture);

    expect(readdirSync(dirname(fixture.paths.runtime)).sort()).toEqual(parentEntries);
    expect(cacheRuntimeSnapshot(fixture.sourceRuntime)).toEqual(source);
    expect(stageSnapshot(fixture.paths.stage, fixture.journal)).toEqual(stage);
    expect(projectRuntimeSnapshot(fixture.paths.runtime)).toEqual(destination);
    expect(projectRuntimeSnapshot(fixture.paths.backup)).toEqual(backup);
    expect(readFileSync(fixture.paths.backupMarker, 'utf8')).toBe(backupMarker);
  });

  it('keeps a backup intent open when neither destination nor backup is present', async () => {
    const fixture = await createPendingRenameFixture('destination-backup-create', 'neither');
    const parentEntries = readdirSync(dirname(fixture.paths.runtime)).sort();
    const source = cacheRuntimeSnapshot(fixture.sourceRuntime);
    const stage = stageSnapshot(fixture.paths.stage, fixture.journal);

    expect(existsSync(fixture.paths.runtime)).toBe(false);
    expect(existsSync(fixture.paths.backup)).toBe(false);

    await expectAmbiguousRecovery(fixture);

    expect(readdirSync(dirname(fixture.paths.runtime)).sort()).toEqual(parentEntries);
    expect(cacheRuntimeSnapshot(fixture.sourceRuntime)).toEqual(source);
    expect(stageSnapshot(fixture.paths.stage, fixture.journal)).toEqual(stage);
    expect(existsSync(fixture.paths.runtime)).toBe(false);
    expect(existsSync(fixture.paths.backup)).toBe(false);
    expect(existsSync(fixture.paths.backupMarker)).toBe(false);
  });

  it('keeps an install intent open when stage and destination are both present', async () => {
    const fixture = await createPendingRenameFixture('destination-install', 'both');
    const parentEntries = readdirSync(dirname(fixture.paths.runtime)).sort();
    const source = cacheRuntimeSnapshot(fixture.sourceRuntime);
    const stage = stageSnapshot(fixture.paths.stage, fixture.journal);
    const destination = projectRuntimeSnapshot(fixture.paths.runtime);

    await expectAmbiguousRecovery(fixture);

    expect(readdirSync(dirname(fixture.paths.runtime)).sort()).toEqual(parentEntries);
    expect(cacheRuntimeSnapshot(fixture.sourceRuntime)).toEqual(source);
    expect(stageSnapshot(fixture.paths.stage, fixture.journal)).toEqual(stage);
    expect(projectRuntimeSnapshot(fixture.paths.runtime)).toEqual(destination);
  });

  it('keeps an install intent open when neither stage nor destination is present', async () => {
    const fixture = await createPendingRenameFixture('destination-install', 'neither');
    const parentEntries = readdirSync(dirname(fixture.paths.runtime)).sort();
    const source = cacheRuntimeSnapshot(fixture.sourceRuntime);

    expect(existsSync(fixture.paths.stage)).toBe(false);
    expect(existsSync(fixture.paths.runtime)).toBe(false);

    await expectAmbiguousRecovery(fixture);

    expect(readdirSync(dirname(fixture.paths.runtime)).sort()).toEqual(parentEntries);
    expect(cacheRuntimeSnapshot(fixture.sourceRuntime)).toEqual(source);
    expect(existsSync(fixture.paths.stage)).toBe(false);
    expect(existsSync(fixture.paths.runtime)).toBe(false);
  });
});
