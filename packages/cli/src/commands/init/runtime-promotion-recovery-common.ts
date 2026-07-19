import { join } from 'node:path';

import { hasErrorCode } from './error-code.js';
import { RuntimeManifestError, runtimeManifestIdentityEqual } from './runtime-manifest.js';
import { runtimePromotionOutcomeRequiresOriginalDestination } from './runtime-promotion-destination-authority.js';
import { canonicalRuntimePromotionCacheChild } from './runtime-promotion-preflight-fs.js';
import {
  RuntimePromotionDatastoreError,
  RuntimePromotionPreflightError,
} from './runtime-promotion-preflight.js';

import type { VerifiedRuntimeManifest } from './runtime-manifest.js';
import type {
  RuntimeManifestIdentity,
  RuntimePromotionJournal,
} from './runtime-promotion-journal-schema.js';
import type {
  DurableClosedPromotionJournal,
  DurableOpenPromotionJournal,
  DurablePromotionJournal,
} from './runtime-promotion-journal.js';
import type {
  RuntimePromotionRecoveryExplicitInputs,
  RuntimePromotionRecoveryOperation,
} from './runtime-promotion-recovery-types.js';

export function recoveryInputsCompatible(
  journal: RuntimePromotionJournal,
  explicit: RuntimePromotionRecoveryExplicitInputs | undefined,
): boolean {
  if (explicit === undefined) return true;
  if (
    explicit.languages !== undefined &&
    (explicit.languages.length !== journal.inputs.languages.length ||
      explicit.languages.some((language, index) => language !== journal.inputs.languages[index]))
  ) {
    return false;
  }
  if (
    explicit.authoredMode !== undefined &&
    explicit.authoredMode !== journal.inputs.authoredMode
  ) {
    return false;
  }
  return (
    explicit.conflict === undefined ||
    journal.source.classification === 'none' ||
    explicit.conflict === journal.inputs.conflict
  );
}

export function recoveryFailureReason(
  error: unknown,
  journal: RuntimePromotionJournal | undefined,
):
  | 'operation-failed'
  | 'journal-malformed'
  | 'journal-oversize'
  | 'journal-key-mismatch'
  | 'journal-phase-invalid'
  | 'artifact-mismatch'
  | 'state-ambiguous' {
  if (journal === undefined) {
    const message = error instanceof Error ? error.message : '';
    if (message.includes('exceeds its bounded size')) return 'journal-oversize';
    if (message.includes('another project key')) return 'journal-key-mismatch';
    if (
      message.includes('malformed') ||
      message.includes('canonically encoded') ||
      hasErrorCode(error, 'SYSTEM.INIT.PROMOTION_JOURNAL')
    ) {
      return 'journal-malformed';
    }
    return 'state-ambiguous';
  }
  if (hasErrorCode(error, 'SYSTEM.INIT.PROMOTION_JOURNAL')) {
    return 'journal-phase-invalid';
  }
  if (
    error instanceof RuntimeManifestError ||
    error instanceof RuntimePromotionDatastoreError ||
    error instanceof RuntimePromotionPreflightError ||
    hasErrorCode(error, 'SYSTEM.INIT.AUTHORED_TRANSACTION') ||
    hasErrorCode(error, 'SYSTEM.INIT.RUNTIME_PROMOTION_FILESYSTEM')
  ) {
    return 'artifact-mismatch';
  }
  return 'operation-failed';
}

export function deriveRecoverySourceRuntime(
  journal: RuntimePromotionJournal,
  ephemeralProjectsDir: string,
): string | undefined {
  const cacheKey = journal.source.cacheKey;
  if (cacheKey === null) return undefined;
  try {
    return canonicalRuntimePromotionCacheChild(ephemeralProjectsDir, cacheKey).runtimeDir;
  } catch {
    // Test seams and a temporarily unavailable root may not be canonicalizable
    // at this path-only derivation step. Every source read/mutation boundary
    // independently binds the exact canonical cache child and journaled inode.
    return join(ephemeralProjectsDir, cacheKey);
  }
}

export function assertRecoveryProjectRoot(operation: RuntimePromotionRecoveryOperation): void {
  operation.dependencies.assertProjectRootAuthority({
    lease: operation.lease,
    authority: operation.projectRootAuthority,
  });
}

/** @throws {Error} When the selected recovery source no longer has exact authority. */
export function assertRecoverySourceAuthority(
  operation: RuntimePromotionRecoveryOperation,
): string {
  if (operation.sourceRuntime === undefined) {
    throw new Error('Source-backed recovery lacks its canonical cache location');
  }
  assertRecoveryProjectRoot(operation);
  operation.dependencies.assertSourceAuthority({
    projectRoot: operation.input.projectRoot,
    sourceRuntime: operation.sourceRuntime,
    source: operation.journal.source,
    lease: operation.lease,
  });
  assertRecoveryProjectRoot(operation);
  return operation.sourceRuntime;
}

/** @throws {Error} When the recovery source is absent or no longer canonically located. */
export function assertRecoverySourceLocation(operation: RuntimePromotionRecoveryOperation): string {
  if (operation.sourceRuntime === undefined) {
    throw new Error('Source-backed recovery lacks its canonical cache location');
  }
  assertRecoveryProjectRoot(operation);
  operation.dependencies.assertSourceLocation({
    projectRoot: operation.input.projectRoot,
    sourceRuntime: operation.sourceRuntime,
    source: operation.journal.source,
    lease: operation.lease,
  });
  assertRecoveryProjectRoot(operation);
  return operation.sourceRuntime;
}

export async function refreshRecoveryJournal(
  operation: RuntimePromotionRecoveryOperation,
  expectedReceipt: DurablePromotionJournal = operation.receipt,
): Promise<RuntimePromotionJournal> {
  assertRecoveryProjectRoot(operation);
  operation.journal = await operation.controller.verifyReceipt(expectedReceipt, {
    state: expectedReceipt.state,
  });
  return operation.journal;
}

/** @throws {Error} When a durable recovery receipt is not open. */
export function asRecoveryOpen(
  operation: RuntimePromotionRecoveryOperation,
): DurableOpenPromotionJournal {
  if (operation.receipt.state !== 'open') {
    throw new Error('Open recovery cannot use a closed journal receipt');
  }
  return operation.receipt;
}

/** @throws {Error} When a durable recovery receipt is not closed. */
export function asRecoveryClosed(
  operation: RuntimePromotionRecoveryOperation,
): DurableClosedPromotionJournal {
  if (operation.receipt.state !== 'closed') {
    throw new Error('Closed recovery cannot use an open journal receipt');
  }
  return operation.receipt;
}

/** @throws {Error} When required durable recovery manifest evidence is absent. */
export function requireManifest(
  manifest: RuntimeManifestIdentity | null,
  description: string,
): RuntimeManifestIdentity {
  if (manifest === null) {
    throw new Error(`${description} lacks its recorded runtime manifest`);
  }
  return manifest;
}

/** @throws {Error} When observed recovery manifest identity differs from the journal. */
export function inspectExactRecoveryManifest(
  operation: RuntimePromotionRecoveryOperation,
  runtimeDir: string,
  posture: 'cache-source' | 'project-runtime',
  expected: RuntimeManifestIdentity,
): VerifiedRuntimeManifest {
  assertRecoveryProjectRoot(operation);
  const observed = operation.dependencies.inspectManifest(runtimeDir, posture);
  assertRecoveryProjectRoot(operation);
  if (!runtimeManifestIdentityEqual(observed.identity, expected)) {
    throw new Error('Recovered runtime authority does not match the durable journal');
  }
  return observed;
}

type RecoveryAuthoredTransaction = NonNullable<RuntimePromotionRecoveryOperation['transaction']>;

export async function bindRecoveryAuthoredReceipt(
  operation: RuntimePromotionRecoveryOperation,
): Promise<RecoveryAuthoredTransaction | null> {
  if (operation.transaction === null) return null;
  const transaction = operation.transaction;
  await operation.dependencies.bindAuthoredReceipt(transaction, asRecoveryOpen(operation));
  return transaction;
}

export async function loadRecoveryAuthored(
  operation: RuntimePromotionRecoveryOperation,
): Promise<void> {
  if (operation.transaction !== null) {
    await bindRecoveryAuthoredReceipt(operation);
    return;
  }
  assertRecoveryProjectRoot(operation);
  const loaded = await operation.dependencies.loadAuthored({
    projectRoot: operation.input.projectRoot,
    projectRootAuthority: operation.projectRootAuthority,
    lease: operation.lease,
    controller: operation.controller,
    receipt: asRecoveryOpen(operation),
  });
  assertRecoveryProjectRoot(operation);
  operation.transaction = loaded.transaction;
  operation.receipt = loaded.receipt;
  operation.authoredSummary = loaded.summary;
}

export function recoveryAuthoredWasMaterialized(journal: RuntimePromotionJournal): boolean {
  return (
    journal.cleanup.authoredStage !== 'unmaterialized' ||
    journal.cleanup.authoredBackup !== 'unmaterialized' ||
    journal.cleanup.replayManifest !== 'unmaterialized'
  );
}

export function recoveryRuntimeAuthority(input: {
  readonly journal: RuntimePromotionJournal;
  readonly outcome: 'committed' | 'rolled-back';
}): {
  readonly location: 'project' | 'cache' | 'none';
  readonly manifest: RuntimeManifestIdentity | null;
} {
  const { journal } = input;
  if (input.outcome === 'committed') {
    if (journal.route === 'authored-only') return { location: 'none', manifest: null };
    return {
      location: 'project',
      manifest:
        journal.route === 'promote-cache'
          ? journal.manifests.runtimeStage
          : journal.manifests.destination,
    };
  }
  if (
    journal.route === 'project-authority' ||
    journal.route === 'keep-project' ||
    journal.route === 'deduplicate-cache' ||
    (journal.route === 'promote-cache' && journal.destinationRuntimePreexisting)
  ) {
    return { location: 'project', manifest: journal.manifests.destination };
  }
  if (journal.route === 'promote-cache') {
    return { location: 'cache', manifest: journal.manifests.source };
  }
  return { location: 'none', manifest: null };
}

/** @throws {Error} When open recovery runtime authority cannot be proven exactly. */
export function inspectOpenRecoveryRuntimeAuthority(
  operation: RuntimePromotionRecoveryOperation,
  outcome: 'committed' | 'rolled-back',
): RuntimeManifestIdentity | null {
  let selectedSource: RuntimeManifestIdentity | null = null;
  if (outcome === 'rolled-back' && operation.journal.source.classification !== 'none') {
    const sourceRuntime = assertRecoverySourceAuthority(operation);
    selectedSource = inspectExactRecoveryManifest(
      operation,
      sourceRuntime,
      'cache-source',
      requireManifest(operation.journal.manifests.source, 'Recovered selected source'),
    ).identity;
  }
  const authority = recoveryRuntimeAuthority({
    journal: operation.journal,
    outcome,
  });
  if (authority.location === 'none') {
    if (authority.manifest !== null) {
      throw new Error('Runtime-free recovery unexpectedly retained a manifest');
    }
    return null;
  }
  const expected = requireManifest(authority.manifest, 'Recovered authority');
  if (authority.location === 'cache') {
    if (selectedSource === null) {
      throw new Error('Recovered cache authority lacks selected-source verification');
    }
    return selectedSource;
  }
  const destinationRuntime = join(operation.input.projectRoot, 'opensip-cli', '.runtime');
  const inspect = () =>
    inspectExactRecoveryManifest(operation, destinationRuntime, 'project-runtime', expected);
  const requiresOriginal = runtimePromotionOutcomeRequiresOriginalDestination(
    operation.journal,
    outcome,
  );
  if (requiresOriginal) {
    operation.dependencies.assertDestinationRootAuthority({
      runtimeDir: destinationRuntime,
      journal: operation.journal,
    });
  }
  const observed = inspect();
  if (requiresOriginal) {
    operation.dependencies.assertDestinationRootAuthority({
      runtimeDir: destinationRuntime,
      journal: operation.journal,
    });
  }
  return observed.identity;
}
