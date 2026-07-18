import { lstatSync, rmdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  expectedBlobNames,
  expectedOwner,
  ownerFor,
} from './authored-state-transaction-artifacts.js';
import {
  authoredTransactionFailure,
  fsyncDirectory,
  readBoundedAuthoredDirectory,
  readStableArtifactFile,
} from './authored-state-transaction-fs.js';
import { AUTHORED_ARTIFACT_OWNER_FILE } from './authored-state-transaction-types.js';
import { INIT_AUTHORED_PLAN_CAPS } from './init-authored-plan-types.js';

import type { AuthoredArtifactPaths } from './authored-state-transaction-types.js';
import type { AuthoredReplayManifest, InitAuthoredMutation } from './init-authored-plan.js';
import type { RuntimePromotionJournal } from './runtime-promotion-journal-schema.js';

interface ExactBlobRoot {
  readonly hasBlobDirectory: boolean;
  readonly blobNames: readonly string[];
}

function inspectExactBlobDirectory(
  blobDirectory: string,
  expected: ReadonlyMap<string, InitAuthoredMutation>,
  kind: 'desired' | 'preimage',
): readonly string[] {
  const stat = lstatSync(blobDirectory, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || Number(stat.mode & 0o777n) !== 0o700) {
    authoredTransactionFailure('an incomplete authored blob directory is unsafe');
  }
  const blobNames = readBoundedAuthoredDirectory(
    blobDirectory,
    expected.size,
    expected.size * INIT_AUTHORED_PLAN_CAPS.maxBlobNameBytes,
    'owned authored blob directory',
  );
  for (const basename of blobNames) {
    const mutation = expected.get(basename);
    if (mutation === undefined) {
      authoredTransactionFailure('an incomplete authored artifact has an unowned blob');
    }
    const state = kind === 'desired' ? mutation.desired : mutation.preimage;
    const file = readStableArtifactFile(join(blobDirectory, basename));
    if (file.mode !== state.mode || file.digest !== state.digest) {
      authoredTransactionFailure('an incomplete authored blob is changed');
    }
  }
  return blobNames;
}

function inspectExactBlobRoot(
  rootPath: string,
  journal: RuntimePromotionJournal,
  manifest: AuthoredReplayManifest,
  role: 'stage' | 'backup',
): ExactBlobRoot {
  const kind = role === 'stage' ? 'desired' : 'preimage';
  expectedOwner(rootPath, ownerFor(journal, role));
  const expected = expectedBlobNames(manifest, kind);
  const rootNames = new Set(
    readBoundedAuthoredDirectory(
      rootPath,
      2,
      2 * INIT_AUTHORED_PLAN_CAPS.maxBlobNameBytes,
      'owned authored root',
    ),
  );
  if (!rootNames.delete(AUTHORED_ARTIFACT_OWNER_FILE)) {
    authoredTransactionFailure('an incomplete authored artifact has no ownership marker');
  }
  const hasBlobDirectory = rootNames.delete(kind);
  if (rootNames.size > 0) {
    authoredTransactionFailure('an incomplete authored artifact has unowned entries');
  }
  if (!hasBlobDirectory) return { hasBlobDirectory: false, blobNames: [] };
  return {
    hasBlobDirectory: true,
    blobNames: inspectExactBlobDirectory(join(rootPath, kind), expected, kind),
  };
}

export function removeOwnedAuthoredBlobRoot(
  journal: RuntimePromotionJournal,
  manifest: AuthoredReplayManifest,
  paths: AuthoredArtifactPaths,
  slot: 'authoredStage' | 'authoredBackup',
): void {
  const role = slot === 'authoredStage' ? 'stage' : 'backup';
  const rootPath = slot === 'authoredStage' ? paths.stageRoot : paths.backupRoot;
  const kind = role === 'stage' ? 'desired' : 'preimage';
  const inspected = inspectExactBlobRoot(rootPath, journal, manifest, role);
  if (inspected.hasBlobDirectory) {
    const blobDirectory = join(rootPath, kind);
    for (const basename of inspected.blobNames) {
      unlinkSync(join(blobDirectory, basename));
    }
    fsyncDirectory(blobDirectory);
    rmdirSync(blobDirectory);
  }
  unlinkSync(join(rootPath, AUTHORED_ARTIFACT_OWNER_FILE));
  fsyncDirectory(rootPath);
  rmdirSync(rootPath);
  fsyncDirectory(dirname(rootPath));
}
