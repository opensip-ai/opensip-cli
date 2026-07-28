import { SystemError } from '@opensip-cli/core';

import { hostErrorCatalog } from '../../errors/host-error-catalog.js';

import {
  isRuntimeManifestReleaseUnsafe,
  runtimeManifestIdentityEqual,
} from './runtime-manifest.js';
import { authorityUnverified } from './runtime-promotion-authority-error.js';
import { runtimePromotionOutcomeRequiresOriginalDestination } from './runtime-promotion-destination-authority.js';
import { assertFreshRuntimePromotionProjectRoot } from './runtime-promotion-root-authority.js';

import type {
  RuntimeManifestIdentity,
  RuntimePromotionJournal,
} from './runtime-promotion-journal-schema.js';
import type {
  DurableClosedPromotionJournal,
  DurableOpenPromotionJournal,
} from './runtime-promotion-journal.js';
import type { RuntimePromotionOperation } from './runtime-promotion-types.js';

const SOURCE_UNVERIFIED = hostErrorCatalog.require('CLI.INIT.PROMOTION_SOURCE_UNVERIFIED');

/**
 * A selected promotion source that failed authority verification.
 *
 * Extends `SystemError` rather than bare `Error` so the failure carries machine identity. It
 * previously extended `Error`, which meant no code, normalization to `SYSTEM_ERROR`, and a
 * redacted message — on a failure whose `releaseSafe` flag decides whether the process-owned
 * runtime lease may be released.
 *
 * The CLASS is kept, not replaced by a plain `SystemError`: `isRuntimePromotionAuthorityReleaseUnsafe`
 * branches on `instanceof` to read `releaseSafe`, and that decision is not expressible as a code.
 */
export class RuntimePromotionSelectedSourceError extends SystemError {
  public readonly releaseSafe: boolean;

  public constructor(message: string, cause?: unknown) {
    const releaseSafe = !isRuntimePromotionAuthorityReleaseUnsafe(cause);
    super(message, {
      code: SOURCE_UNVERIFIED.code,
      definition: SOURCE_UNVERIFIED,
      metadata: { condition: 'selected-source-unverified', releaseSafe },
      ...(cause === undefined ? {} : { cause }),
    });
    this.name = 'RuntimePromotionSelectedSourceError';
    this.releaseSafe = releaseSafe;
    Object.setPrototypeOf(this, RuntimePromotionSelectedSourceError.prototype);
  }
}

export function isRuntimePromotionAuthorityReleaseUnsafe(error: unknown): boolean {
  return (
    isRuntimeManifestReleaseUnsafe(error) ||
    (error instanceof RuntimePromotionSelectedSourceError && !error.releaseSafe)
  );
}

type AuthoredTransaction = NonNullable<RuntimePromotionOperation['transaction']>;

async function bindAuthoredForVerification(
  operation: RuntimePromotionOperation,
  transaction: AuthoredTransaction,
  receipt: DurableOpenPromotionJournal,
): Promise<AuthoredTransaction> {
  await operation.dependencies.bindAuthoredReceipt(transaction, receipt);
  return transaction;
}

/** @throws {SystemError} When the observed manifest no longer matches the expected identity. */
function assertExactManifest(
  expected: RuntimeManifestIdentity,
  observed: RuntimeManifestIdentity,
  message: string,
  condition: string,
): void {
  if (!runtimeManifestIdentityEqual(expected, observed)) {
    authorityUnverified(message, condition);
  }
}

/** @throws {SystemError} When a required durable manifest identity is absent. */
function requiredManifest(
  manifest: RuntimeManifestIdentity | null,
  message: string,
  condition: string,
): RuntimeManifestIdentity {
  if (manifest === null) authorityUnverified(message, condition);
  return manifest;
}

function committedRuntimeManifest(
  journal: RuntimePromotionJournal,
): RuntimeManifestIdentity | null {
  if (journal.route === 'authored-only') return null;
  return journal.route === 'promote-cache'
    ? requiredManifest(
        journal.manifests.runtimeStage,
        'Committed promotion lacks its installed runtime manifest',
        'committed-runtime-stage-manifest-absent',
      )
    : requiredManifest(
        journal.manifests.destination,
        'Committed promotion lacks its project runtime manifest',
        'committed-destination-manifest-absent',
      );
}

function rolledBackRuntimeManifest(
  journal: RuntimePromotionJournal,
): RuntimeManifestIdentity | null {
  if (journal.route === 'authored-only') return null;
  if (journal.route === 'promote-cache' && !journal.destinationRuntimePreexisting) {
    return requiredManifest(
      journal.manifests.source,
      'Rolled-back promotion lacks its selected source manifest',
      'rolled-back-source-manifest-absent',
    );
  }
  return requiredManifest(
    journal.manifests.destination,
    'Rolled-back promotion lacks its restored project runtime manifest',
    'rolled-back-destination-manifest-absent',
  );
}

/** @throws {SystemError} When the open journal cannot prove the requested authored-state authority. */
async function verifyOpenAuthoredAuthority(
  operation: RuntimePromotionOperation,
  receipt: DurableOpenPromotionJournal,
  expected: 'desired' | 'preimage',
): Promise<void> {
  if (operation.transaction === null) {
    if (expected === 'desired') {
      authorityUnverified(
        'Committed promotion lacks its authored-state transaction',
        'open-authored-transaction-absent',
      );
    }
    return;
  }
  assertFreshRuntimePromotionProjectRoot(operation);
  const transaction = await bindAuthoredForVerification(operation, operation.transaction, receipt);
  assertFreshRuntimePromotionProjectRoot(operation);
  const summary = await operation.dependencies.verifyAuthored(transaction, expected);
  assertFreshRuntimePromotionProjectRoot(operation);
  if (!summary.verified) {
    authorityUnverified(
      `Authored ${expected} authority was not verified`,
      'open-authored-authority-unverified',
    );
  }
  operation.authoredSummary = summary;
}

/** @throws {SystemError} When the closed journal cannot prove the requested authored-state authority. */
async function verifyClosedAuthoredAuthority(
  operation: RuntimePromotionOperation,
  receipt: DurableClosedPromotionJournal,
  expected: 'desired' | 'preimage',
): Promise<void> {
  if (operation.transaction === null) {
    if (expected === 'desired') {
      authorityUnverified(
        'Committed promotion lacks its authored-state transaction',
        'closed-authored-transaction-absent',
      );
    }
    return;
  }
  assertFreshRuntimePromotionProjectRoot(operation);
  const transaction = await operation.dependencies.loadClosedAuthored({
    projectRoot: operation.input.projectRoot,
    projectRootAuthority: operation.projectRootAuthority,
    lease: operation.lease,
    controller: operation.controller,
    receipt,
  });
  assertFreshRuntimePromotionProjectRoot(operation);
  const summary = await operation.dependencies.verifyAuthored(transaction, expected);
  assertFreshRuntimePromotionProjectRoot(operation);
  if (!summary.verified) {
    authorityUnverified(
      `Closed authored ${expected} authority was not verified`,
      'closed-authored-authority-unverified',
    );
  }
  operation.authoredSummary = summary;
}

/** @throws {RuntimePromotionSelectedSourceError} When selected-source authority cannot be reverified. */
function verifySelectedSource(
  operation: RuntimePromotionOperation,
  journal: RuntimePromotionJournal,
): RuntimeManifestIdentity | null {
  if (operation.preflight.source.classification === 'none') return null;
  const expected = journal.manifests.source;
  const sourceRuntimeDir = operation.preflight.sourceRuntimeDir;
  if (expected === null || sourceRuntimeDir === undefined) {
    operation.sourcePreserved = false;
    throw new RuntimePromotionSelectedSourceError(
      'Rolled-back promotion lacks exact selected source evidence',
    );
  }
  try {
    assertFreshRuntimePromotionProjectRoot(operation);
    const observed = operation.dependencies.inspectManifest(sourceRuntimeDir, 'cache-source');
    assertFreshRuntimePromotionProjectRoot(operation);
    assertExactManifest(
      expected,
      observed.identity,
      'Selected cache source changed before rolled-back authority was sealed',
      'rolled-back-source-changed',
    );
    operation.sourcePreserved = true;
    return observed.identity;
  } catch (error) {
    operation.sourcePreserved = false;
    throw new RuntimePromotionSelectedSourceError(
      'Selected cache source could not be reverified before rollback completed',
      error,
    );
  }
}

function verifyProjectRuntime(
  operation: RuntimePromotionOperation,
  journal: RuntimePromotionJournal,
  outcome: 'committed' | 'rolled-back',
  expected: RuntimeManifestIdentity,
  message: string,
  condition: string,
): RuntimeManifestIdentity {
  assertFreshRuntimePromotionProjectRoot(operation);
  const inspect = () =>
    operation.dependencies.inspectManifest(
      operation.preflight.destinationRuntimeDir,
      'project-runtime',
    );
  const requiresOriginal = runtimePromotionOutcomeRequiresOriginalDestination(journal, outcome);
  if (requiresOriginal) {
    operation.dependencies.assertDestinationRootAuthority({
      runtimeDir: operation.preflight.destinationRuntimeDir,
      journal,
    });
  }
  const observed = inspect();
  if (requiresOriginal) {
    operation.dependencies.assertDestinationRootAuthority({
      runtimeDir: operation.preflight.destinationRuntimeDir,
      journal,
    });
  }
  assertFreshRuntimePromotionProjectRoot(operation);
  assertExactManifest(expected, observed.identity, message, condition);
  return observed.identity;
}

function verifyCommittedRuntimeAuthority(
  operation: RuntimePromotionOperation,
  journal: RuntimePromotionJournal,
): RuntimeManifestIdentity | null {
  const expected = committedRuntimeManifest(journal);
  return expected === null
    ? null
    : verifyProjectRuntime(
        operation,
        journal,
        'committed',
        expected,
        'Project runtime changed before committed authority completed',
        'committed-project-runtime-changed',
      );
}

/** @throws {RuntimePromotionSelectedSourceError} When rolled-back runtime authority cannot be proven. */
function verifyRolledBackRuntimeAuthority(
  operation: RuntimePromotionOperation,
  journal: RuntimePromotionJournal,
): RuntimeManifestIdentity | null {
  const selectedSource = verifySelectedSource(operation, journal);
  const expected = rolledBackRuntimeManifest(journal);
  if (expected === null) return null;
  const observed =
    journal.route === 'promote-cache' && !journal.destinationRuntimePreexisting
      ? selectedSource
      : verifyProjectRuntime(
          operation,
          journal,
          'rolled-back',
          expected,
          'Project runtime changed before rolled-back authority completed',
          'rolled-back-project-runtime-changed',
        );
  if (expected !== null && observed === null) {
    throw new RuntimePromotionSelectedSourceError(
      'Rolled-back cache authority could not be reverified',
    );
  }
  return observed;
}

async function verifyCommittedAuthoredAuthority(
  operation: RuntimePromotionOperation,
  receipt: DurableOpenPromotionJournal,
  journal: RuntimePromotionJournal,
): Promise<RuntimeManifestIdentity | null> {
  verifyCommittedRuntimeAuthority(operation, journal);
  await verifyOpenAuthoredAuthority(operation, receipt, 'desired');
  return verifyCommittedRuntimeAuthority(operation, journal);
}

async function verifyRolledBackAuthoredAuthority(
  operation: RuntimePromotionOperation,
  receipt: DurableOpenPromotionJournal,
  journal: RuntimePromotionJournal,
): Promise<RuntimeManifestIdentity | null> {
  verifyRolledBackRuntimeAuthority(operation, journal);
  await verifyOpenAuthoredAuthority(operation, receipt, 'preimage');
  return verifyRolledBackRuntimeAuthority(operation, journal);
}

export async function verifyCommittedOperationAuthority(
  operation: RuntimePromotionOperation,
  receipt: DurableOpenPromotionJournal,
): Promise<RuntimeManifestIdentity | null> {
  const journal = await operation.controller.verifyOpen(receipt);
  return verifyCommittedAuthoredAuthority(operation, receipt, journal);
}

export async function verifyRolledBackOperationAuthority(
  operation: RuntimePromotionOperation,
  receipt: DurableOpenPromotionJournal,
): Promise<RuntimeManifestIdentity | null> {
  const journal = await operation.controller.verifyOpen(receipt);
  return verifyRolledBackAuthoredAuthority(operation, receipt, journal);
}

/** @throws {Error} When the open terminal outcome or its authority cannot be verified. */
export async function verifyOpenTerminalOperationAuthority(
  operation: RuntimePromotionOperation,
  receipt: DurableOpenPromotionJournal,
): Promise<void> {
  const journal = await operation.controller.verifyOpen(receipt);
  const terminal = journal.terminal;
  if (terminal === null) {
    authorityUnverified(
      'Open promotion has no terminal authority to verify',
      'open-terminal-authority-absent',
    );
  }
  if (terminal.outcome === 'committed') {
    await verifyCommittedOperationAuthority(operation, receipt);
    return;
  }
  await verifyRolledBackOperationAuthority(operation, receipt);
}

/** @throws {Error} When the closed terminal outcome or its authority cannot be verified. */
export async function verifyClosedTerminalOperationAuthority(
  operation: RuntimePromotionOperation,
  receipt: DurableClosedPromotionJournal,
): Promise<void> {
  const journal = await operation.controller.verifyReceipt(receipt, {
    state: 'closed',
  });
  const terminal = journal.terminal;
  if (terminal === null) {
    authorityUnverified(
      'Closed promotion has no terminal authority to verify',
      'closed-terminal-authority-absent',
    );
  }
  if (terminal.outcome === 'committed') {
    verifyCommittedRuntimeAuthority(operation, journal);
    await verifyClosedAuthoredAuthority(operation, receipt, 'desired');
    verifyCommittedRuntimeAuthority(operation, journal);
    return;
  }
  verifyRolledBackRuntimeAuthority(operation, journal);
  await verifyClosedAuthoredAuthority(operation, receipt, 'preimage');
  verifyRolledBackRuntimeAuthority(operation, journal);
}

/** Re-verify closed terminal authority and return the same receipt for chaining. */
export async function verifyClosedTerminalReceipt(
  operation: RuntimePromotionOperation,
  receipt: DurableClosedPromotionJournal,
): Promise<DurableClosedPromotionJournal> {
  await verifyClosedTerminalOperationAuthority(operation, receipt);
  return receipt;
}
