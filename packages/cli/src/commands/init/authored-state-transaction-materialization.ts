import { join } from "node:path";

import {
  encodeOwner,
  ownerFor,
} from "./authored-state-transaction-artifacts.js";
import {
  assertStableAuthoredRoot,
  authoredTransactionFailure,
  createDurableDirectory,
  fsyncDirectory,
  writeExclusiveDurableFile,
  type DurableFileWriteCheckpoint,
  type StableAuthoredRoot,
} from "./authored-state-transaction-fs.js";
import {
  AUTHORED_ARTIFACT_OWNER_FILE,
  type AuthoredArtifactPaths,
  type AuthoredArtifactRole,
  type AuthoredStateCheckpoint,
} from "./authored-state-transaction-types.js";
import {
  INIT_AUTHORED_PLAN_CAPS,
  sha256Bytes,
} from "./init-authored-plan-types.js";

import type {
  InitAuthoredMutation,
  InitAuthoredPlan,
} from "./init-authored-plan.js";
import type { RuntimePromotionJournal } from "./runtime-promotion-journal-schema.js";

interface ArtifactCheckpoints {
  readonly rootMkdir: AuthoredStateCheckpoint;
  readonly marker: Readonly<
    Record<DurableFileWriteCheckpoint, AuthoredStateCheckpoint>
  >;
  readonly blobDirectoryMkdir: AuthoredStateCheckpoint;
  readonly blob: Readonly<
    Record<DurableFileWriteCheckpoint, AuthoredStateCheckpoint>
  >;
}

const CHECKPOINTS: Readonly<Record<AuthoredArtifactRole, ArtifactCheckpoints>> =
  {
    stage: {
      rootMkdir: "after-stage-root-mkdir",
      marker: {
        opened: "after-stage-marker-open",
        "partial-written": "after-stage-marker-partial-write",
        fsynced: "after-stage-marker-fsync",
      },
      blobDirectoryMkdir: "after-stage-blob-directory-mkdir",
      blob: {
        opened: "after-stage-blob-open",
        "partial-written": "after-stage-blob-partial-write",
        fsynced: "after-stage-blob-fsync",
      },
    },
    backup: {
      rootMkdir: "after-backup-root-mkdir",
      marker: {
        opened: "after-backup-marker-open",
        "partial-written": "after-backup-marker-partial-write",
        fsynced: "after-backup-marker-fsync",
      },
      blobDirectoryMkdir: "after-backup-blob-directory-mkdir",
      blob: {
        opened: "after-backup-blob-open",
        "partial-written": "after-backup-blob-partial-write",
        fsynced: "after-backup-blob-fsync",
      },
    },
  };

function blobBytes(
  plan: InitAuthoredPlan,
  kind: "desired" | "preimage",
  name: string,
): Buffer {
  const encoded = plan.blobs[kind][name];
  if (encoded === undefined) {
    authoredTransactionFailure("the plan is missing a referenced blob");
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) {
    authoredTransactionFailure("the plan contains a noncanonical blob");
  }
  return bytes;
}

function blobMutations(
  mutations: readonly InitAuthoredMutation[],
  kind: "desired" | "preimage",
): readonly InitAuthoredMutation[] {
  return mutations.filter((mutation) =>
    kind === "desired"
      ? mutation.desiredBlob !== null
      : mutation.preimageBlob !== null,
  );
}

function writeBlob(
  rootPath: string,
  mutation: InitAuthoredMutation,
  kind: "desired" | "preimage",
  plan: InitAuthoredPlan,
  checkpoints: ArtifactCheckpoints,
  checkpoint: (value: AuthoredStateCheckpoint) => void,
): void {
  const name =
    kind === "desired" ? mutation.desiredBlob : mutation.preimageBlob;
  const state = kind === "desired" ? mutation.desired : mutation.preimage;
  if (
    name === null ||
    !state.exists ||
    state.type !== "file" ||
    state.mode === null
  ) {
    authoredTransactionFailure("a blob reference has an impossible state");
  }
  const basename = name.split("/")[1];
  if (basename === undefined) {
    authoredTransactionFailure("a blob reference is malformed");
  }
  const bytes = blobBytes(plan, kind, name);
  if (bytes.length > INIT_AUTHORED_PLAN_CAPS.maxFileBytes) {
    authoredTransactionFailure("an authored blob exceeds its file cap");
  }
  if (sha256Bytes(bytes) !== state.digest) {
    authoredTransactionFailure(
      "an authored blob disagrees with its manifest digest",
    );
  }
  writeExclusiveDurableFile(
    join(rootPath, kind, basename),
    bytes,
    state.mode,
    (value) => checkpoint(checkpoints.blob[value]),
  );
}

function writeArtifactRoot(
  rootPath: string,
  journal: RuntimePromotionJournal,
  role: AuthoredArtifactRole,
  kind: "desired" | "preimage",
  plan: InitAuthoredPlan,
  checkpoint: (value: AuthoredStateCheckpoint) => void,
): void {
  const checkpoints = CHECKPOINTS[role];
  createDurableDirectory(rootPath);
  checkpoint(checkpoints.rootMkdir);
  writeExclusiveDurableFile(
    join(rootPath, AUTHORED_ARTIFACT_OWNER_FILE),
    Buffer.from(encodeOwner(ownerFor(journal, role)), "utf8"),
    0o600,
    (value) => checkpoint(checkpoints.marker[value]),
  );
  fsyncDirectory(rootPath);
  const mutations = blobMutations(plan.mutations, kind);
  if (mutations.length > 0) {
    createDurableDirectory(join(rootPath, kind));
    checkpoint(checkpoints.blobDirectoryMkdir);
  }
  for (const mutation of mutations) {
    writeBlob(rootPath, mutation, kind, plan, checkpoints, checkpoint);
  }
  if (mutations.length > 0) fsyncDirectory(join(rootPath, kind));
  fsyncDirectory(rootPath);
}

export function materializeAuthoredBlobRoots(
  root: StableAuthoredRoot,
  journal: RuntimePromotionJournal,
  plan: InitAuthoredPlan,
  paths: AuthoredArtifactPaths,
  checkpoint: (value: AuthoredStateCheckpoint) => void,
): void {
  assertStableAuthoredRoot(root);
  writeArtifactRoot(
    paths.stageRoot,
    journal,
    "stage",
    "desired",
    plan,
    checkpoint,
  );
  checkpoint("after-stage-materialization");
  writeArtifactRoot(
    paths.backupRoot,
    journal,
    "backup",
    "preimage",
    plan,
    checkpoint,
  );
  checkpoint("after-backup-materialization");
  assertStableAuthoredRoot(root);
}
