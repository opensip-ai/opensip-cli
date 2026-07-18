import {
  assertStablePromotionDirectory,
  closeStablePromotionDirectory,
  openStablePromotionDirectory,
  runtimePromotionFilesystemFailure,
} from './runtime-promotion-filesystem-io.js';

import type { RuntimePromotionJournal } from './runtime-promotion-journal-schema.js';

function requiredDestinationRootIdentity(journal: RuntimePromotionJournal): {
  readonly device: string;
  readonly inode: string;
} {
  const identity = journal.destinationRootIdentity;
  if (!journal.destinationRuntimePreexisting || identity === null) {
    runtimePromotionFilesystemFailure(
      'preexisting project runtime authority lacks its journal root identity',
    );
  }
  return identity;
}

/**
 * Hold the exact preexisting project runtime open while reading it, and reassert
 * both the handle and public path before returning. Manifest equality alone
 * cannot distinguish a byte-identical replacement directory.
 */
export function withRuntimePromotionDestinationRootAuthority<T>(
  runtimeDir: string,
  journal: RuntimePromotionJournal,
  use: () => T,
): T {
  const expected = requiredDestinationRootIdentity(journal);
  const directory = openStablePromotionDirectory(runtimeDir, 'the preexisting project runtime');
  try {
    if (
      directory.identity.dev.toString() !== expected.device ||
      directory.identity.ino.toString() !== expected.inode
    ) {
      runtimePromotionFilesystemFailure(
        'the preexisting project runtime was replaced after journal creation',
      );
    }
    assertStablePromotionDirectory(directory, 'the preexisting project runtime');
    const result = use();
    assertStablePromotionDirectory(directory, 'the preexisting project runtime');
    return result;
  } finally {
    closeStablePromotionDirectory(directory);
  }
}

export function assertRuntimePromotionDestinationRootAuthority(
  runtimeDir: string,
  journal: RuntimePromotionJournal,
): void {
  withRuntimePromotionDestinationRootAuthority(runtimeDir, journal, () => null);
}

export function runtimePromotionOutcomeRequiresOriginalDestination(
  journal: RuntimePromotionJournal,
  outcome: 'committed' | 'rolled-back',
): boolean {
  return (
    journal.destinationRuntimePreexisting &&
    (outcome === 'rolled-back' || journal.route !== 'promote-cache')
  );
}
