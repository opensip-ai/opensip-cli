import type {
  DurableOpenPromotionJournal,
  RuntimePromotionJournalController,
} from './runtime-promotion-journal.js';
import type { RuntimePromotionProjectRootAuthority } from './runtime-promotion-root-authority.js';
import type { RuntimeExclusiveLease } from '@opensip-cli/core';
import type {
  DataStoreLockContext,
  DatastoreCloseResult,
  SqliteIntegrityResult,
} from '@opensip-cli/datastore';

export type RuntimePromotionDatastoreKind = 'source' | 'destination';

export type RuntimePromotionDatastoreCandidate =
  | {
      readonly kind: 'source';
      readonly runtimeDir: string;
    }
  | {
      readonly kind: 'destination';
      readonly runtimeDir: string;
    };

export interface RuntimePromotionDatastoreCheckpointInput {
  /** Callers supply canonical operation order; this helper never parallelizes. */
  readonly candidates: readonly RuntimePromotionDatastoreCandidate[];
  readonly lockContext: DataStoreLockContext;
  readonly projectRootAuthority: RuntimePromotionProjectRootAuthority;
  readonly lease: RuntimeExclusiveLease;
  readonly controller: Pick<RuntimePromotionJournalController, 'assertBoundLease' | 'verifyOpen'>;
  readonly receipt: DurableOpenPromotionJournal;
}

export type RuntimePromotionDatastoreIdentity =
  | {
      readonly kind: RuntimePromotionDatastoreKind;
      readonly status: 'absent';
    }
  | {
      readonly kind: RuntimePromotionDatastoreKind;
      readonly status: 'verified';
      readonly sha256: string;
      readonly sizeBytes: number;
      readonly userVersion: number;
      readonly supportedVersion: number;
    };

export type RuntimePromotionDatastoreFailureReason =
  | 'candidate-set-invalid'
  | 'checkpoint-incomplete'
  | 'database-invalid'
  | 'database-unsupported'
  | 'database-unreadable';

interface RuntimePromotionDatastoreCheckpointOptions {
  readonly lockPath: string;
  readonly beforeOpen: () => void;
  readonly afterOpen: () => void;
  readonly beforeCheckpoint: () => void;
  readonly afterClose: () => void;
}

interface RuntimePromotionDatastoreInspectionOptions {
  readonly beforeOpen: () => void;
}

export interface RuntimePromotionDatastoreDependencies {
  readonly checkpoint: (
    path: string,
    lockContext: DataStoreLockContext,
    options: RuntimePromotionDatastoreCheckpointOptions,
  ) => DatastoreCloseResult | Promise<DatastoreCloseResult>;
  readonly inspect: (
    path: string,
    options: RuntimePromotionDatastoreInspectionOptions,
  ) => SqliteIntegrityResult;
  readonly mainFilePresence: (path: string) => 'absent' | 'file' | 'unsafe';
  readonly beforeCheckpoint?: (kind: RuntimePromotionDatastoreKind) => void;
  readonly afterCandidate?: (kind: RuntimePromotionDatastoreKind) => void;
}
