import { join } from 'node:path';

import { encodeOwner, ownerFor } from './authored-state-transaction-artifacts.js';
import {
  assertStableAuthoredRoot,
  assertStableAuthoredEntry,
  authoredTransactionFailure,
  bindStableAuthoredEntry,
  createDurableDirectory,
  fsyncStableAuthoredDirectory,
  writeExclusiveDurableFile,
  type DurableFileWriteCheckpoint,
  type StableAuthoredEntry,
  type StableAuthoredRoot,
} from './authored-state-transaction-fs.js';
import {
  AUTHORED_ARTIFACT_OWNER_FILE,
  type AuthoredArtifactPaths,
  type AuthoredArtifactRole,
  type AuthoredStateCheckpoint,
} from './authored-state-transaction-types.js';
import { INIT_AUTHORED_PLAN_CAPS, sha256Bytes } from './init-authored-plan-types.js';

import type { InitAuthoredMutation, InitAuthoredPlan } from './init-authored-plan.js';
import type { RuntimePromotionJournal } from './runtime-promotion-journal-schema.js';

interface ArtifactCheckpoints {
  readonly rootMkdir: AuthoredStateCheckpoint;
  readonly marker: Readonly<Record<DurableFileWriteCheckpoint, AuthoredStateCheckpoint>>;
  readonly blobDirectoryMkdir: AuthoredStateCheckpoint;
  readonly blob: Readonly<Record<DurableFileWriteCheckpoint, AuthoredStateCheckpoint>>;
}

interface AuthoredArtifactRootAuthority {
  readonly root: StableAuthoredEntry;
  readonly blobDirectory: StableAuthoredEntry | null;
}

export interface AuthoredMaterializationAuthority {
  readonly stage: AuthoredArtifactRootAuthority;
  readonly backup: AuthoredArtifactRootAuthority;
}

const ARTIFACT_ROOT_DESCRIPTION = 'the authored artifact root';
const BLOB_DIRECTORY_DESCRIPTION = 'the authored blob directory';

const CHECKPOINTS: Readonly<Record<AuthoredArtifactRole, ArtifactCheckpoints>> = {
  stage: {
    rootMkdir: 'after-stage-root-mkdir',
    marker: {
      opened: 'after-stage-marker-open',
      'partial-written': 'after-stage-marker-partial-write',
      fsynced: 'after-stage-marker-fsync',
    },
    blobDirectoryMkdir: 'after-stage-blob-directory-mkdir',
    blob: {
      opened: 'after-stage-blob-open',
      'partial-written': 'after-stage-blob-partial-write',
      fsynced: 'after-stage-blob-fsync',
    },
  },
  backup: {
    rootMkdir: 'after-backup-root-mkdir',
    marker: {
      opened: 'after-backup-marker-open',
      'partial-written': 'after-backup-marker-partial-write',
      fsynced: 'after-backup-marker-fsync',
    },
    blobDirectoryMkdir: 'after-backup-blob-directory-mkdir',
    blob: {
      opened: 'after-backup-blob-open',
      'partial-written': 'after-backup-blob-partial-write',
      fsynced: 'after-backup-blob-fsync',
    },
  },
};

function blobBytes(plan: InitAuthoredPlan, kind: 'desired' | 'preimage', name: string): Buffer {
  const encoded = plan.blobs[kind][name];
  if (encoded === undefined) {
    authoredTransactionFailure('the plan is missing a referenced blob');
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded) {
    authoredTransactionFailure('the plan contains a noncanonical blob');
  }
  return bytes;
}

function blobMutations(
  mutations: readonly InitAuthoredMutation[],
  kind: 'desired' | 'preimage',
): readonly InitAuthoredMutation[] {
  return mutations.filter((mutation) =>
    kind === 'desired' ? mutation.desiredBlob !== null : mutation.preimageBlob !== null,
  );
}

function writeBlob(
  rootPath: string,
  artifactRoot: StableAuthoredEntry,
  blobDirectory: StableAuthoredEntry,
  mutation: InitAuthoredMutation,
  kind: 'desired' | 'preimage',
  plan: InitAuthoredPlan,
  checkpoints: ArtifactCheckpoints,
  checkpoint: (value: AuthoredStateCheckpoint) => void,
): void {
  const name = kind === 'desired' ? mutation.desiredBlob : mutation.preimageBlob;
  const state = kind === 'desired' ? mutation.desired : mutation.preimage;
  if (name === null || !state.exists || state.type !== 'file' || state.mode === null) {
    authoredTransactionFailure('a blob reference has an impossible state');
  }
  const basename = name.split('/')[1];
  if (basename === undefined) {
    authoredTransactionFailure('a blob reference is malformed');
  }
  const bytes = blobBytes(plan, kind, name);
  if (bytes.length > INIT_AUTHORED_PLAN_CAPS.maxFileBytes) {
    authoredTransactionFailure('an authored blob exceeds its file cap');
  }
  if (sha256Bytes(bytes) !== state.digest) {
    authoredTransactionFailure('an authored blob disagrees with its manifest digest');
  }
  assertStableAuthoredEntry(artifactRoot, ARTIFACT_ROOT_DESCRIPTION);
  assertStableAuthoredEntry(blobDirectory, BLOB_DIRECTORY_DESCRIPTION);
  writeExclusiveDurableFile(join(rootPath, kind, basename), bytes, state.mode, (value) => {
    assertStableAuthoredEntry(artifactRoot, ARTIFACT_ROOT_DESCRIPTION);
    assertStableAuthoredEntry(blobDirectory, BLOB_DIRECTORY_DESCRIPTION);
    checkpoint(checkpoints.blob[value]);
    assertStableAuthoredEntry(artifactRoot, ARTIFACT_ROOT_DESCRIPTION);
    assertStableAuthoredEntry(blobDirectory, BLOB_DIRECTORY_DESCRIPTION);
  });
  assertStableAuthoredEntry(artifactRoot, ARTIFACT_ROOT_DESCRIPTION);
  assertStableAuthoredEntry(blobDirectory, BLOB_DIRECTORY_DESCRIPTION);
}

function writeArtifactRoot(
  rootPath: string,
  journal: RuntimePromotionJournal,
  role: AuthoredArtifactRole,
  kind: 'desired' | 'preimage',
  plan: InitAuthoredPlan,
  checkpoint: (value: AuthoredStateCheckpoint) => void,
): AuthoredArtifactRootAuthority {
  const checkpoints = CHECKPOINTS[role];
  const artifactRoot = createDurableDirectory(rootPath, () => checkpoint(checkpoints.rootMkdir));
  const rootCheckpoint = (value: AuthoredStateCheckpoint): void => {
    assertStableAuthoredEntry(artifactRoot, ARTIFACT_ROOT_DESCRIPTION);
    checkpoint(value);
    assertStableAuthoredEntry(artifactRoot, ARTIFACT_ROOT_DESCRIPTION);
  };
  writeExclusiveDurableFile(
    join(rootPath, AUTHORED_ARTIFACT_OWNER_FILE),
    Buffer.from(encodeOwner(ownerFor(journal, role)), 'utf8'),
    0o600,
    (value) => rootCheckpoint(checkpoints.marker[value]),
  );
  fsyncStableAuthoredDirectory(artifactRoot, ARTIFACT_ROOT_DESCRIPTION);
  const mutations = blobMutations(plan.mutations, kind);
  let blobDirectory: StableAuthoredEntry | null = null;
  if (mutations.length > 0) {
    assertStableAuthoredEntry(artifactRoot, ARTIFACT_ROOT_DESCRIPTION);
    blobDirectory = createDurableDirectory(join(rootPath, kind), () =>
      rootCheckpoint(checkpoints.blobDirectoryMkdir),
    );
    assertStableAuthoredEntry(artifactRoot, ARTIFACT_ROOT_DESCRIPTION);
    assertStableAuthoredEntry(blobDirectory, BLOB_DIRECTORY_DESCRIPTION);
  }
  for (const mutation of mutations) {
    if (blobDirectory === null) {
      authoredTransactionFailure('an authored blob directory was not materialized');
    }
    writeBlob(rootPath, artifactRoot, blobDirectory, mutation, kind, plan, checkpoints, checkpoint);
  }
  if (blobDirectory !== null) {
    fsyncStableAuthoredDirectory(blobDirectory, BLOB_DIRECTORY_DESCRIPTION);
  }
  fsyncStableAuthoredDirectory(artifactRoot, ARTIFACT_ROOT_DESCRIPTION);
  return { root: artifactRoot, blobDirectory };
}

function bindArtifactRootAuthority(
  rootPath: string,
  kind: 'desired' | 'preimage',
  plan: InitAuthoredPlan,
): AuthoredArtifactRootAuthority {
  const root = bindStableAuthoredEntry(rootPath, 'directory', ARTIFACT_ROOT_DESCRIPTION);
  const blobDirectory =
    blobMutations(plan.mutations, kind).length === 0
      ? null
      : bindStableAuthoredEntry(join(rootPath, kind), 'directory', BLOB_DIRECTORY_DESCRIPTION);
  assertStableAuthoredEntry(root, ARTIFACT_ROOT_DESCRIPTION);
  return { root, blobDirectory };
}

export function bindAuthoredMaterializationAuthority(
  plan: InitAuthoredPlan,
  paths: AuthoredArtifactPaths,
): AuthoredMaterializationAuthority {
  const stage = bindArtifactRootAuthority(paths.stageRoot, 'desired', plan);
  const backup = bindArtifactRootAuthority(paths.backupRoot, 'preimage', plan);
  assertAuthoredMaterializationAuthority({ stage, backup });
  return { stage, backup };
}

function assertArtifactRootAuthority(authority: AuthoredArtifactRootAuthority): void {
  assertStableAuthoredEntry(authority.root, ARTIFACT_ROOT_DESCRIPTION);
  if (authority.blobDirectory !== null) {
    assertStableAuthoredEntry(authority.blobDirectory, BLOB_DIRECTORY_DESCRIPTION);
  }
}

export function assertAuthoredMaterializationAuthority(
  authority: AuthoredMaterializationAuthority,
): void {
  assertArtifactRootAuthority(authority.stage);
  assertArtifactRootAuthority(authority.backup);
}

export function materializeAuthoredBlobRoots(
  root: StableAuthoredRoot,
  journal: RuntimePromotionJournal,
  plan: InitAuthoredPlan,
  paths: AuthoredArtifactPaths,
  checkpoint: (value: AuthoredStateCheckpoint) => void,
): AuthoredMaterializationAuthority {
  assertStableAuthoredRoot(root);
  const stage = writeArtifactRoot(paths.stageRoot, journal, 'stage', 'desired', plan, checkpoint);
  assertStableAuthoredEntry(stage.root, 'the authored stage root');
  checkpoint('after-stage-materialization');
  assertStableAuthoredEntry(stage.root, 'the authored stage root');
  const backup = writeArtifactRoot(
    paths.backupRoot,
    journal,
    'backup',
    'preimage',
    plan,
    checkpoint,
  );
  assertStableAuthoredEntry(backup.root, 'the authored backup root');
  checkpoint('after-backup-materialization');
  assertAuthoredMaterializationAuthority({ stage, backup });
  assertStableAuthoredRoot(root);
  return { stage, backup };
}
