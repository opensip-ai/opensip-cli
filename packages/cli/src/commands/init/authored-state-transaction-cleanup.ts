import { lstatSync, unlinkSync } from "node:fs";

import {
  assertStableAuthoredRoot,
  authoredTransactionFailure,
  fsyncDirectory,
  readStableArtifactFile,
  type StableAuthoredRoot,
} from "./authored-state-transaction-fs.js";
import { removeOwnedAuthoredBlobRoot } from "./authored-state-transaction-owned-artifact-cleanup.js";

import type { AuthoredArtifactPaths } from "./authored-state-transaction-types.js";
import type { AuthoredReplayManifest } from "./init-authored-plan.js";
import type { RuntimePromotionJournal } from "./runtime-promotion-journal-schema.js";

function artifactPath(
  paths: AuthoredArtifactPaths,
  slot: "authoredStage" | "authoredBackup" | "replayManifest",
): string {
  if (slot === "authoredStage") return paths.stageRoot;
  if (slot === "authoredBackup") return paths.backupRoot;
  return paths.replayManifest;
}

export function removeAuthoredArtifact(
  root: StableAuthoredRoot,
  journal: RuntimePromotionJournal,
  manifest: AuthoredReplayManifest | null,
  paths: AuthoredArtifactPaths,
  slot: "authoredStage" | "authoredBackup" | "replayManifest",
): "removed" | "absent" {
  const path = artifactPath(paths, slot);
  try {
    lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw error;
  }
  if (slot === "replayManifest") {
    const replay = readStableArtifactFile(path);
    if (replay.mode !== 0o600 || replay.digest !== journal.plan.replayDigest) {
      authoredTransactionFailure("cleanup refused a changed replay manifest");
    }
    unlinkSync(path);
    fsyncDirectory(root.path);
    return "removed";
  }
  if (manifest === null) {
    authoredTransactionFailure(
      "cleanup requires the replay manifest for artifact directories",
    );
  }
  removeOwnedAuthoredBlobRoot(journal, manifest, paths, slot);
  assertStableAuthoredRoot(root);
  return "removed";
}
