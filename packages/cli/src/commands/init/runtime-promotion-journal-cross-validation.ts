/** Temporal, route, and terminal relationships over an already-shaped journal. */
/* eslint-disable sonarjs/no-duplicate-string -- closed route and phase literals keep the invariant matrix auditable */

import { isDeepStrictEqual } from 'node:util';

import { runtimePromotionClosedEvidenceAllowed } from './runtime-promotion-closed-evidence.js';
import {
  runtimePromotionLastPostconditionCompatible,
  runtimePromotionPendingIntentAllowed,
  runtimePromotionPhaseEvidenceAllowed,
} from './runtime-promotion-intent-policy.js';
import { journalFailure } from './runtime-promotion-journal-validation-helpers.js';
import { runtimePromotionRouteEvidenceAllowed } from './runtime-promotion-route-evidence.js';

import type {
  RuntimeManifestIdentity,
  RuntimePromotionJournal,
  RuntimePromotionTerminal,
} from './runtime-promotion-journal-types.js';

function validateRoute(journal: RuntimePromotionJournal): void {
  if (journal.destinationRuntimePreexisting && !journal.destinationParentPreexisting) {
    journalFailure('a preexisting destination runtime requires a preexisting parent');
  }
  const sourcePresent = journal.source.classification !== 'none';
  const sourceRoute = ['promote-cache', 'keep-project', 'deduplicate-cache'].includes(
    journal.route,
  );
  if (sourcePresent !== sourceRoute) journalFailure('route and source classification disagree');
  if (
    journal.route === 'deduplicate-cache' &&
    journal.source.classification !== 'generation-bound'
  ) {
    journalFailure('weak sources cannot use automatic deduplication');
  }
  if (
    journal.route === 'deduplicate-cache' &&
    journal.manifests.source !== null &&
    journal.manifests.destination !== null &&
    !isDeepStrictEqual(journal.manifests.source, journal.manifests.destination)
  ) {
    journalFailure('deduplicated source and destination manifests must match exactly');
  }
  const destinationRequired = ['project-authority', 'keep-project', 'deduplicate-cache'].includes(
    journal.route,
  );
  if (
    (journal.route === 'authored-only' && journal.destinationRuntimePreexisting) ||
    (destinationRequired && !journal.destinationRuntimePreexisting)
  ) {
    journalFailure('route and destination runtime preexistence disagree');
  }
  if (
    journal.route === 'promote-cache' &&
    journal.inputs.conflict === 'abort' &&
    (journal.destinationRuntimePreexisting || journal.source.classification !== 'generation-bound')
  ) {
    journalFailure('unsafe cache promotion requires explicit use-cache conflict authority');
  }
  const keepMatches =
    (journal.route === 'keep-project') === (journal.inputs.conflict === 'keep-project');
  const useCacheMatches =
    journal.inputs.conflict !== 'use-cache' || journal.route === 'promote-cache';
  const otherRouteAborts =
    ['keep-project', 'promote-cache'].includes(journal.route) ||
    journal.inputs.conflict === 'abort';
  if (!keepMatches || !useCacheMatches || !otherRouteAborts) {
    journalFailure('conflict policy and selected route disagree');
  }
}

function validateCounters(journal: RuntimePromotionJournal): void {
  if (
    journal.counts.authoredCompleted !== journal.progress.authoredCursor ||
    journal.counts.authoredRolledBack !== journal.progress.rollbackCursor
  ) {
    journalFailure('authored counts must match progress cursors');
  }
  if (
    journal.progress.pendingIntent !== null &&
    journal.progress.pendingIntent.sequence !== journal.counts.intentCount
  ) {
    journalFailure('pending intent sequence must match intent count');
  }
  if (
    (journal.progress.pendingIntent === null &&
      journal.counts.intentCount !== journal.counts.postconditionCount) ||
    (journal.progress.pendingIntent !== null &&
      journal.counts.intentCount !== journal.counts.postconditionCount + 1)
  ) {
    journalFailure('intent and postcondition counts do not describe one pending mutation');
  }
  const last = journal.progress.lastPostcondition;
  if (
    (journal.counts.postconditionCount === 0 && last !== null) ||
    (journal.counts.postconditionCount > 0 && last?.sequence !== journal.counts.postconditionCount)
  ) {
    journalFailure('last postcondition must match the exact postcondition count');
  }
  const minimumRevision =
    journal.counts.intentCount + journal.counts.postconditionCount + (journal.recoveryAttempt - 1);
  if (journal.revision < minimumRevision) {
    journalFailure('revision cannot be lower than its durable transition history');
  }
}

function validateIntentHistory(journal: RuntimePromotionJournal): void {
  const { createdAt, updatedAt } = journal.timestamps;
  const pending = journal.progress.pendingIntent;
  const last = journal.progress.lastPostcondition;
  const pendingInvalid =
    pending !== null &&
    (pending.recordedAt < createdAt ||
      pending.recordedAt > updatedAt ||
      !runtimePromotionPendingIntentAllowed(journal, pending));
  const lastInvalid =
    last !== null &&
    (last.recordedAt < createdAt ||
      last.recordedAt > updatedAt ||
      !runtimePromotionLastPostconditionCompatible(journal));
  const orderInvalid = pending !== null && last !== null && last.sequence >= pending.sequence;
  if (pendingInvalid || lastInvalid || orderInvalid) {
    journalFailure('intent history is temporally or structurally impossible');
  }
}

function validateState(journal: RuntimePromotionJournal): void {
  if (journal.state === 'open') {
    if (journal.timestamps.closedAt !== null || journal.progress.direction === 'cleanup') {
      journalFailure('open journal cannot contain closed cleanup state');
    }
    return;
  }
  if (
    journal.timestamps.closedAt === null ||
    journal.terminal === null ||
    journal.progress.direction !== 'cleanup'
  ) {
    journalFailure('closed journal requires terminal cleanup authority');
  }
}

function committedManifest(journal: RuntimePromotionJournal): RuntimeManifestIdentity | null {
  if (journal.route === 'promote-cache') return journal.manifests.runtimeStage;
  if (journal.route === 'authored-only') return null;
  return journal.manifests.destination;
}

function rolledBackAuthority(journal: RuntimePromotionJournal): {
  readonly authority: 'project' | 'cache' | 'none';
  readonly manifest: RuntimeManifestIdentity | null;
} {
  if (
    journal.route === 'project-authority' ||
    journal.route === 'keep-project' ||
    journal.route === 'deduplicate-cache'
  ) {
    return { authority: 'project', manifest: journal.manifests.destination };
  }
  if (journal.route === 'promote-cache') {
    return journal.destinationRuntimePreexisting
      ? { authority: 'project', manifest: journal.manifests.destination }
      : { authority: 'cache', manifest: journal.manifests.source };
  }
  return { authority: 'none', manifest: null };
}

function validateTerminalSeal(
  journal: RuntimePromotionJournal,
  terminal: RuntimePromotionTerminal,
): void {
  const sealingPhase = terminal.outcome === 'committed' ? 'committed' : 'rolled-back';
  const timeInvalid =
    terminal.verifiedAt < journal.timestamps.createdAt ||
    terminal.verifiedAt > journal.timestamps.updatedAt;
  if (
    !terminal.authoredVerified ||
    (journal.state === 'open' && journal.progress.phase !== sealingPhase) ||
    timeInvalid
  ) {
    journalFailure('terminal requires exact authored verification and sealing phase');
  }
  if (
    (terminal.outcome === 'committed' &&
      journal.progress.authoredCursor !== journal.plan.mutationCount) ||
    (terminal.outcome === 'rolled-back' &&
      journal.progress.rollbackCursor !== journal.progress.authoredCursor)
  ) {
    journalFailure('terminal authored cursors do not prove complete commit or rollback');
  }
  const committedRuntimeState =
    journal.route === 'promote-cache'
      ? journal.progress.runtimeInstallState === 'installed'
      : journal.progress.runtimeInstallState === 'not-installed';
  const runtimeStateAllowed =
    terminal.outcome === 'committed'
      ? committedRuntimeState
      : journal.progress.runtimeInstallState !== 'installed';
  if (!runtimeStateAllowed) {
    journalFailure('terminal outcome does not match durable runtime install state');
  }
  const sourcePreserved =
    terminal.outcome === 'rolled-back' && journal.source.classification !== 'none';
  if (terminal.sourcePreserved !== sourcePreserved) {
    journalFailure('terminal source-preservation proof does not match the outcome');
  }
}

function validateCommittedAuthority(
  journal: RuntimePromotionJournal,
  terminal: RuntimePromotionTerminal,
): void {
  if (terminal.outcome !== 'committed') return;
  const authoredOnly = journal.route === 'authored-only';
  if (
    terminal.authority !== (authoredOnly ? 'none' : 'project') ||
    (!authoredOnly && terminal.runtimeManifest === null)
  ) {
    journalFailure('committed terminal authority is inconsistent with its route');
  }
}

function validateTerminalAuthority(
  journal: RuntimePromotionJournal,
  terminal: RuntimePromotionTerminal,
): void {
  validateCommittedAuthority(journal, terminal);
  const rollback = rolledBackAuthority(journal);
  if (terminal.outcome === 'committed') {
    return;
  }
  const sourceRoute = journal.source.classification !== 'none';
  if (journal.destinationRuntimePreexisting && journal.manifests.destination === null) {
    journalFailure('rolled-back project authority requires a verified destination manifest');
  }
  if (sourceRoute && journal.manifests.source === null) {
    journalFailure('rolled-back source authority requires a verified source manifest');
  }
  if (sourceRoute && !journal.destinationRuntimePreexisting && terminal.authority !== 'cache') {
    journalFailure('rolled-back source fallback requires cache authority');
  }
  if (terminal.authority !== rollback.authority) {
    journalFailure('rolled-back terminal authority does not match available evidence');
  }
}

function validateTerminalManifest(
  journal: RuntimePromotionJournal,
  terminal: RuntimePromotionTerminal,
): void {
  const rollback = rolledBackAuthority(journal);
  const expected =
    terminal.outcome === 'committed' ? committedManifest(journal) : rollback.manifest;
  if (!isDeepStrictEqual(terminal.runtimeManifest, expected)) {
    journalFailure(`${terminal.outcome} terminal manifest does not match selected authority`);
  }
}

function validateTerminal(journal: RuntimePromotionJournal): void {
  const terminal = journal.terminal;
  if (terminal === null) {
    if (
      ['committed', 'rolled-back'].includes(journal.progress.phase) ||
      journal.state === 'closed'
    ) {
      journalFailure('terminal phase or state requires terminal authority');
    }
    return;
  }
  validateTerminalSeal(journal, terminal);
  validateTerminalAuthority(journal, terminal);
  validateTerminalManifest(journal, terminal);
}

export function validateRuntimePromotionCrossFields(journal: RuntimePromotionJournal): void {
  validateRoute(journal);
  validateCounters(journal);
  validateIntentHistory(journal);
  validateState(journal);
  if (!runtimePromotionRouteEvidenceAllowed(journal)) {
    journalFailure('journal route lacks compatible manifest or owned-artifact evidence');
  }
  if (!runtimePromotionClosedEvidenceAllowed(journal)) {
    journalFailure('journal terminal history or cleanup count is inconsistent');
  }
  if (!runtimePromotionPhaseEvidenceAllowed(journal)) {
    journalFailure('journal phase lacks its required durable postcondition evidence');
  }
  validateTerminal(journal);
}
