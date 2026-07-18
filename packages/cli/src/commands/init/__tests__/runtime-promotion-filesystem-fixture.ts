import { chmodSync, existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { projectCoordinationKey, type RuntimeExclusiveLease } from '@opensip-cli/core';

import {
  inspectVerifiedRuntimeManifest,
  type RuntimeTreePosture,
  type VerifiedRuntimeManifest,
} from '../runtime-manifest.js';
import { capturePromotionRootIdentity } from '../runtime-promotion-filesystem-io.js';
import {
  authorizeRuntimePromotionFilesystem,
  runtimePromotionOwnerMarkerBasename,
} from '../runtime-promotion-filesystem.js';
import {
  createInitialRuntimePromotionJournal,
  createRuntimePromotionOwnedSlots,
  type RuntimeManifestIdentity,
  type RuntimePromotionJournal,
  type RuntimePromotionOwnedSlotName,
  type RuntimePromotionRootIdentity,
  type RuntimePromotionRoute,
} from '../runtime-promotion-journal-schema.js';
import { captureRuntimePromotionProjectRootAuthority } from '../runtime-promotion-root-authority.js';

import type {
  AuthorizeRuntimePromotionFilesystemInput,
  RuntimePromotionFilesystemAction,
  RuntimePromotionFilesystemAuthority,
  RuntimePromotionFilesystemDependencies,
} from '../runtime-promotion-filesystem.js';
import type {
  DurablePromotionJournal,
  RuntimePromotionJournalController,
} from '../runtime-promotion-journal.js';
import type { RuntimePromotionProjectRootAuthority } from '../runtime-promotion-root-authority.js';

export const TEST_OPERATION_ID = 'runtime-filesystem-test-operation';
const TEST_OWNER_TOKEN = 'runtime-filesystem-test-owner-token';
const TEST_TIMESTAMP = Date.parse('2026-07-17T12:00:00.000Z');
const TEST_DIGEST = 'a'.repeat(64);

const INTENT_BY_ACTION: Readonly<
  Record<
    RuntimePromotionFilesystemAction,
    {
      readonly kind:
        | 'destination-parent-create'
        | 'runtime-stage-create'
        | 'destination-backup-create'
        | 'destination-install'
        | 'source-retire'
        | 'runtime-rollback'
        | 'owned-slot-cleanup';
      readonly slot: RuntimePromotionOwnedSlotName;
    }
  >
> = {
  'destination-parent-create': {
    kind: 'destination-parent-create',
    slot: 'destinationParent',
  },
  'runtime-stage-reconcile': {
    kind: 'runtime-stage-create',
    slot: 'runtimeStage',
  },
  'destination-backup-create': {
    kind: 'destination-backup-create',
    slot: 'destinationBackup',
  },
  'destination-install': {
    kind: 'destination-install',
    slot: 'destinationParent',
  },
  'source-retire': { kind: 'source-retire', slot: 'sourceTombstone' },
  'runtime-rollback': {
    kind: 'runtime-rollback',
    slot: 'destinationBackup',
  },
  'owned-slot-cleanup': {
    kind: 'owned-slot-cleanup',
    slot: 'runtimeStage',
  },
};

export interface FilesystemJournalOptions {
  readonly action: RuntimePromotionFilesystemAction;
  readonly projectRoot: string;
  readonly route?: RuntimePromotionRoute;
  readonly source?: RuntimePromotionJournal['source'];
  readonly sourceManifest?: RuntimeManifestIdentity | null;
  readonly destinationManifest?: RuntimeManifestIdentity | null;
  readonly stageManifest?: RuntimeManifestIdentity | null;
  readonly destinationParentPreexisting?: boolean;
  readonly destinationRuntimePreexisting?: boolean;
  readonly runtimeInstallState?: RuntimePromotionJournal['progress']['runtimeInstallState'];
  readonly authoredCursor?: number;
  readonly runtimeStageCleanup?: RuntimePromotionJournal['cleanup']['runtimeStage'];
  readonly cleanupSlot?: RuntimePromotionOwnedSlotName;
  readonly terminal?: RuntimePromotionJournal['terminal'];
  readonly revision?: number;
}

export function makePrivateDirectory(path: string, mode = 0o700): string {
  mkdirSync(path, { recursive: true, mode });
  if (process.platform !== 'win32') chmodSync(path, mode);
  return path;
}

export function writePrivateFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, content, { encoding: 'utf8', mode: 0o600 });
  if (process.platform !== 'win32') chmodSync(path, 0o600);
}

function captureDestinationRootIdentity(
  destinationRuntimePreexisting: boolean,
  destinationRuntime: string,
  destinationBackup: string,
): RuntimePromotionRootIdentity | null {
  if (!destinationRuntimePreexisting) return null;
  // Lifecycle fixtures often materialize a journal after simulating the
  // destination-backup rename. In that state the original project runtime is
  // the backup object, not the newly installed public destination.
  if (existsSync(destinationBackup)) {
    return capturePromotionRootIdentity(destinationBackup);
  }
  if (existsSync(destinationRuntime)) {
    return capturePromotionRootIdentity(destinationRuntime);
  }
  return { device: '1', inode: '2' };
}

function defaultFilesystemRoute(
  destinationRuntimePreexisting: boolean,
  mutatesPreexistingDestination: boolean,
): RuntimePromotionRoute {
  if (mutatesPreexistingDestination) return 'promote-cache';
  return destinationRuntimePreexisting ? 'project-authority' : 'authored-only';
}

export function verifiedRuntime(
  root: string,
  posture: Extract<RuntimeTreePosture, 'cache-source' | 'project-runtime'> = 'project-runtime',
): VerifiedRuntimeManifest {
  return inspectVerifiedRuntimeManifest(root, posture);
}

export function makeFilesystemJournal(options: FilesystemJournalOptions): RuntimePromotionJournal {
  const operationId = TEST_OPERATION_ID;
  const owned = createRuntimePromotionOwnedSlots(operationId);
  const destinationRuntimePreexisting =
    options.destinationRuntimePreexisting ?? options.cleanupSlot === 'destinationBackup';
  const mutatesPreexistingDestination =
    destinationRuntimePreexisting &&
    (options.cleanupSlot === 'destinationBackup' ||
      ['destination-backup-create', 'destination-install', 'runtime-rollback'].includes(
        options.action,
      ));
  const route =
    options.route ??
    defaultFilesystemRoute(destinationRuntimePreexisting, mutatesPreexistingDestination);
  const source =
    options.source ??
    (['promote-cache', 'keep-project', 'deduplicate-cache'].includes(route)
      ? {
          classification: 'legacy' as const,
          cacheKey: 'e'.repeat(24),
          generationDigest: null,
          markerSha256: null,
          rootIdentity: { device: '1', inode: '1' },
        }
      : {
          classification: 'none' as const,
          cacheKey: null,
          generationDigest: null,
          markerSha256: null,
          rootIdentity: null,
        });
  let conflict: 'abort' | 'keep-project' | 'use-cache' = 'abort';
  if (route === 'keep-project') conflict = 'keep-project';
  else if (route === 'promote-cache') conflict = 'use-cache';
  const destinationRuntime = join(options.projectRoot, 'opensip-cli', '.runtime');
  const destinationBackup = join(
    options.projectRoot,
    'opensip-cli',
    owned.destinationBackup.basename,
  );
  const destinationRoot = captureDestinationRootIdentity(
    destinationRuntimePreexisting,
    destinationRuntime,
    destinationBackup,
  );
  const initial = createInitialRuntimePromotionJournal({
    coordinationKey: projectCoordinationKey(options.projectRoot),
    operationId,
    recoveryOwnerToken: TEST_OWNER_TOKEN,
    destinationParentPreexisting: options.destinationParentPreexisting ?? true,
    destinationRuntimePreexisting,
    destinationRootIdentity: destinationRoot,
    route,
    source,
    inputs: {
      conflict,
      authoredMode: 'fresh',
      languages: ['typescript'],
      languageExplicit: false,
    },
    plan: {
      authoredDigest: TEST_DIGEST,
      replayDigest: 'b'.repeat(64),
      mutationCount: 1,
    },
    owned,
    createdAt: TEST_TIMESTAMP,
  });
  const selected = INTENT_BY_ACTION[options.action];
  const cleanupSlot = options.cleanupSlot ?? selected.slot;
  const closed = options.action === 'owned-slot-cleanup';
  let phase = initial.progress.phase;
  let direction = initial.progress.direction;
  if (options.action === 'runtime-rollback') {
    phase = 'rollback-started';
    direction = 'rollback';
  } else if (closed) {
    phase = 'cleanup';
    direction = 'cleanup';
  }
  return {
    ...initial,
    route,
    revision: options.revision ?? 1,
    state: closed ? 'closed' : 'open',
    source,
    manifests: {
      source: options.sourceManifest ?? null,
      destination: options.destinationManifest ?? null,
      runtimeStage: options.stageManifest ?? null,
    },
    progress: {
      ...initial.progress,
      phase,
      direction,
      runtimeInstallState: options.runtimeInstallState ?? initial.progress.runtimeInstallState,
      authoredCursor: options.authoredCursor ?? initial.progress.authoredCursor,
      pendingIntent: {
        sequence: 1,
        kind: selected.kind,
        slot: cleanupSlot,
        cursor: null,
        recordedAt: TEST_TIMESTAMP + 1,
      },
    },
    terminal: options.terminal ?? initial.terminal,
    cleanup: {
      ...initial.cleanup,
      ...(options.runtimeStageCleanup === undefined
        ? {}
        : { runtimeStage: options.runtimeStageCleanup }),
      ...(closed ? { [cleanupSlot]: 'pending' as const } : {}),
    },
    counts: {
      ...initial.counts,
      intentCount: 1,
    },
    timestamps: {
      ...initial.timestamps,
      updatedAt: TEST_TIMESTAMP + 1,
      closedAt: closed ? TEST_TIMESTAMP + 1 : null,
    },
  };
}

export interface FilesystemAuthorityHarness {
  readonly lease: RuntimeExclusiveLease;
  readonly receipt: DurablePromotionJournal;
  readonly controller: RuntimePromotionJournalController;
  readonly setJournal: (journal: RuntimePromotionJournal) => void;
}

export function makeAuthorityHarness(
  initialJournal: RuntimePromotionJournal,
): FilesystemAuthorityHarness {
  let current = initialJournal;
  const lease = {
    kind: 'runtime-exclusive',
    coordinationKey: initialJournal.coordinationKey,
    posture: 'normal',
    ownerToken: 'runtime-filesystem-lease-owner',
    acquiredAt: TEST_TIMESTAMP,
    release: () => undefined,
  } satisfies RuntimeExclusiveLease;
  const receipt = {
    operationId: initialJournal.operationId,
    recoveryOwnerToken: initialJournal.recoveryOwnerToken,
    createdAt: initialJournal.timestamps.createdAt,
    coordinationKey: initialJournal.coordinationKey,
    revision: initialJournal.revision,
    sha256: 'c'.repeat(64),
    state: initialJournal.state,
  } as DurablePromotionJournal;
  const controller = {
    assertBoundLease(candidate: RuntimeExclusiveLease): void {
      if (candidate !== lease) throw new Error('foreign lease');
    },
    verifyReceipt(candidate: DurablePromotionJournal): Promise<RuntimePromotionJournal> {
      if (candidate !== receipt) throw new Error('foreign receipt');
      return Promise.resolve(current);
    },
  } as RuntimePromotionJournalController;
  return {
    lease,
    receipt,
    controller,
    setJournal: (journal) => {
      current = journal;
    },
  };
}

export async function authorizeFilesystem(
  projectRoot: string,
  action: RuntimePromotionFilesystemAction,
  harness: FilesystemAuthorityHarness,
  options: {
    readonly sourceRuntime?: string;
    readonly cleanupSlot?: RuntimePromotionOwnedSlotName;
    readonly dependencies?: RuntimePromotionFilesystemDependencies;
    readonly projectRootAuthority?: RuntimePromotionProjectRootAuthority;
  } = {},
): Promise<RuntimePromotionFilesystemAuthority> {
  const input: AuthorizeRuntimePromotionFilesystemInput = {
    action,
    projectRoot,
    controller: harness.controller,
    lease: harness.lease,
    projectRootAuthority:
      options.projectRootAuthority ??
      captureRuntimePromotionProjectRootAuthority({
        lease: harness.lease,
        projectRoot: realpathSync(projectRoot),
        expectedPosture: 'normal',
      }),
    receipt: harness.receipt,
    ...(options.sourceRuntime === undefined ? {} : { sourceRuntime: options.sourceRuntime }),
    ...(options.cleanupSlot === undefined ? {} : { cleanupSlot: options.cleanupSlot }),
    ...(options.dependencies === undefined ? {} : { dependencies: options.dependencies }),
  };
  return authorizeRuntimePromotionFilesystem(input);
}

export function filesystemPaths(
  projectRoot: string,
  journal: RuntimePromotionJournal,
): {
  readonly parent: string;
  readonly parentStage: string;
  readonly runtime: string;
  readonly stage: string;
  readonly backup: string;
  readonly parentMarker: string;
  readonly backupMarker: string;
} {
  const parent = join(projectRoot, 'opensip-cli');
  return {
    parent,
    parentStage: join(projectRoot, journal.owned.destinationParent.basename),
    runtime: join(parent, '.runtime'),
    stage: join(parent, journal.owned.runtimeStage.basename),
    backup: join(parent, journal.owned.destinationBackup.basename),
    parentMarker: join(
      projectRoot,
      runtimePromotionOwnerMarkerBasename(journal.owned.destinationParent.basename),
    ),
    backupMarker: join(
      parent,
      runtimePromotionOwnerMarkerBasename(journal.owned.destinationBackup.basename),
    ),
  };
}
