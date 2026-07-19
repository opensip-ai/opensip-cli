/**
 * Host-owned run lifecycle and evidence staging.
 *
 * Tool handlers return a ToolSessionContribution. The host freezes lifecycle
 * timing, assigns identity, and stages a complete immutable StoredSession in a
 * bounded memory owner. The command boundary later commits that Session and its
 * optional parent Run atomically; analysis never holds a datastore write lock.
 */

import { type StoredSession, type StoredSessionHostMetrics } from '@opensip-cli/contracts';
import {
  createRunLifecycle,
  currentScope,
  deriveRunOutcome,
  generatePrefixedId,
  logger as defaultLogger,
  readPackageVersion,
  type ToolRunCompletion,
  type ToolSessionContribution,
} from '@opensip-cli/core';
import { commitEvidenceBundle, type EvidenceBundleCommitResult } from '@opensip-cli/session-store';

import { manifestVersionFor } from './declared-inputs.js';
import { authoritativeEvidenceCwd } from './evidence-cwd.js';
import {
  createHostEvidenceAccumulator,
  type HostEvidenceDrainResult,
  type HostEvidenceOwnerToken,
} from './host-evidence-accumulator.js';
import {
  captureEnvelopeEvidence,
  completionWithoutSession,
} from './run-plane-envelope-evidence.js';
import {
  enforceSessionRetention,
  resolveCurrentSessionRetentionPolicy,
  type ResolvedSessionRetentionPolicy,
} from './session-retention.js';
import { currentSuiteRunContext, suiteSessionFields } from './suite-run-context.js';

import type {
  HostEvidenceFinalizeInput,
  HostEvidenceFinalizeResult,
  RunPlaneDeps,
  RunPlaneFactory,
  RunPlaneInvocation,
  RunSessionStagingStatus,
  StagedEnvelopeEvidence,
} from './run-plane-contract.js';
import type { DataStore } from '@opensip-cli/datastore';

export type {
  HostEvidenceFinalizeInput,
  HostEvidenceFinalizeResult,
  RunActionHooks,
  RunPlaneDeps,
  RunPlaneFactory,
  RunPlaneInvocation,
  RunSessionStagingStatus,
  StagedEnvelopeEvidence,
} from './run-plane-contract.js';
export { currentSuiteRunContext, runWithSuiteRunContext } from './suite-run-context.js';
export type { SuiteRunContext } from './suite-run-context.js';
export { createRunActionHooks, createRunSessionSeam } from './run-plane-adapters.js';

const CLI_VERSION = readPackageVersion(import.meta.url);
const MODULE_TAG = 'cli:run-plane';

// @graph-ignore-next-line graph:near-duplicate-function-body -- factory and invocation closure intentionally share the per-command lifecycle slot.
export function createRunPlaneFactory(deps: RunPlaneDeps): RunPlaneFactory {
  const log = deps.logger ?? defaultLogger;
  const accumulator = createHostEvidenceAccumulator(deps.evidenceLimits);
  const commit = deps.commitEvidence ?? commitEvidenceBundle;
  const finalizations = new WeakMap<HostEvidenceOwnerToken, Promise<HostEvidenceFinalizeResult>>();
  const committedSessionIds = new Set<string>();
  let invocation: RunPlaneInvocation | undefined;

  function safeDatastore(): DataStore | undefined {
    try {
      return deps.getDatastore();
    } catch (error) {
      log.debug?.({
        evt: 'cli.run-plane.datastore_unavailable',
        module: MODULE_TAG,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  function resolveRetentionPolicy(): ResolvedSessionRetentionPolicy {
    return deps.sessionRetentionPolicy?.() ?? resolveCurrentSessionRetentionPolicy();
  }

  function ownerForInvocation(): HostEvidenceOwnerToken {
    const nested = currentSuiteRunContext()?.evidenceOwner;
    return nested !== undefined && accumulator.ownerKind(nested) === 'nested'
      ? nested
      : accumulator.createOwner('ordinary');
  }

  function makeInvocation(): RunPlaneInvocation {
    const lifecycle = createRunLifecycle();
    const owner = ownerForInvocation();
    let completionAttempted = false;
    let stagingStatus: RunSessionStagingStatus = 'none';
    let stagedId: string | undefined;
    let stagedSnapshot: StoredSession | undefined;
    let envelopeSnapshot: StagedEnvelopeEvidence | undefined;

    function sessionId(): string | undefined {
      if (stagedId === undefined) return undefined;
      return accumulator.isSessionLinkable(owner, stagedId) || committedSessionIds.has(stagedId)
        ? stagedId
        : undefined;
    }

    function stagedSession(): StoredSession | undefined {
      const id = sessionId();
      if (id === undefined) return undefined;
      return accumulator.stagedSession(owner, id) ?? stagedSnapshot;
    }

    function completeAndStage(contribution: ToolSessionContribution): StoredSession | undefined {
      if (completionAttempted) return stagedSession();
      completionAttempted = true;
      const snapshot = lifecycle.complete();
      const id = generatePrefixedId(contribution.tool);
      const runOutcome = deriveRunOutcome({
        passed: contribution.passed,
        explicit: contribution.runOutcome,
      });
      const engineVersion = manifestVersionFor(contribution.tool);
      const session: StoredSession = {
        id,
        tool: contribution.tool,
        startedAt: snapshot.startedAt,
        completedAt: snapshot.completedAt,
        cwd: authoritativeEvidenceCwd(contribution.cwd),
        ...suiteSessionFields(),
        recipe: contribution.recipe,
        score: contribution.score,
        passed: contribution.passed,
        runOutcome,
        durationMs: snapshot.durationMs,
        cliVersion: CLI_VERSION,
        ...(engineVersion === undefined ? {} : { engineVersion }),
        payload: contribution.payload,
      };
      if (!accumulator.stageSession(owner, session)) {
        stagingStatus = 'rejected';
        return undefined;
      }
      stagedId = id;
      stagedSnapshot = accumulator.stagedSession(owner, id);
      stagingStatus = 'staged';
      return stagedSession();
    }

    function recordHostMetrics(metrics: StoredSessionHostMetrics): void {
      const id = sessionId();
      if (id === undefined) return;
      const merged = accumulator.mergeHostMetrics(owner, id, metrics);
      // A drained/committed row is intentionally immutable: late metrics are
      // ignored without relabelling durable evidence as rejected. A poison
      // transition, by contrast, makes the ID unlinkable and rejects it.
      if (!merged && !accumulator.isSessionLinkable(owner, id) && !committedSessionIds.has(id)) {
        stagedId = undefined;
        stagedSnapshot = undefined;
        stagingStatus = 'rejected';
      }
    }

    function captureEnvelope(result: unknown): void {
      envelopeSnapshot ??= captureEnvelopeEvidence(result);
    }

    async function completeLiveRender(
      render: () => Promise<ToolRunCompletion | void>,
    ): Promise<ToolRunCompletion | void> {
      const ttyStart = performance.now();
      const completion = await render();
      const ttyBusyMs = Math.max(0, performance.now() - ttyStart);
      captureEnvelope(completion);
      if (completion?.session === undefined) return completion;
      completeAndStage(completion.session);
      recordHostMetrics({ ttyBusyMs });
      return completionWithoutSession(completion);
    }

    function discardEvidence(): void {
      const id = stagedId;
      if (id !== undefined) accumulator.discardSession(owner, id);
      stagedId = undefined;
      stagedSnapshot = undefined;
      stagingStatus = 'discarded';
    }

    return {
      lifecycle,
      owner,
      completeAndStage,
      recordHostMetrics,
      completeLiveRender,
      sessionId,
      stagedSession,
      captureEnvelope,
      stagedEnvelope: () => envelopeSnapshot,
      discardEvidence,
      sessionStagingStatus: () => stagingStatus,
    };
  }

  function enforceRetentionOnce(datastore: DataStore): void {
    try {
      const policy = resolveRetentionPolicy();
      const diagnostic = {
        evt: 'evidence.retention.policy_resolved',
        module: MODULE_TAG,
        source: policy.source,
        keep: policy.keep,
        maxAgeDays: policy.maxAgeDays,
        maxSizeMb: policy.maxSizeMb,
      };
      log.debug?.(diagnostic);
      currentScope()?.diagnostics?.event(
        'persist',
        'debug',
        'evidence.retention.policy_resolved',
        diagnostic,
      );
      enforceSessionRetention(datastore, policy, { logger: log });
    } catch (error) {
      log.warn?.({
        evt: 'cli.run-session.retention_failed',
        module: MODULE_TAG,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function executeDeferredReport(
    drained: Extract<HostEvidenceDrainResult, { readonly status: 'drained' }>,
  ): Promise<void> {
    if (drained.reportEffect === undefined || deps.executeReportEffect === undefined) return;
    try {
      await deps.executeReportEffect(drained.reportEffect);
    } catch (error) {
      const errorName = error instanceof Error ? error.name : 'UnknownError';
      log.warn?.({
        evt: 'cli.report.deferred_open_failed',
        module: MODULE_TAG,
        errorName,
      });
      try {
        await deps.onReportEffectFailure?.({
          effect: drained.reportEffect,
          errorName,
        });
      } catch {
        log.warn?.({
          evt: 'cli.report.deferred_failure_presentation_failed',
          module: MODULE_TAG,
        });
      }
    }
  }

  async function commitDrainedEvidence(
    datastore: DataStore,
    drained: Extract<HostEvidenceDrainResult, { readonly status: 'drained' }>,
  ): Promise<EvidenceBundleCommitResult> {
    let result: EvidenceBundleCommitResult;
    try {
      result = commit(datastore, drained.input);
    } catch {
      result = { status: 'failed', reason: 'write-failed' };
    }
    if (result.status !== 'committed') {
      log.warn?.({
        evt: 'cli.run-evidence.commit_failed',
        module: MODULE_TAG,
        status: result.status,
        ...(result.status === 'failed' ? { reason: result.reason } : {}),
      });
      return result;
    }
    for (const sessionId of result.sessionIds) {
      committedSessionIds.add(sessionId);
      log.info?.({
        evt: 'cli.run-session.recorded',
        module: MODULE_TAG,
        sessionId,
      });
    }
    if (result.runId !== undefined) {
      log.info?.({
        evt: 'cli.run-ledger.standalone_recorded',
        module: MODULE_TAG,
        runId: result.runId,
      });
    }
    await executeDeferredReport(drained);
    return result;
  }

  async function finalizeOwner(
    owner: HostEvidenceOwnerToken,
    input: HostEvidenceFinalizeInput = {},
  ): Promise<HostEvidenceFinalizeResult> {
    const existing = finalizations.get(owner);
    if (existing !== undefined) return existing;

    const pending = (async (): Promise<HostEvidenceFinalizeResult> => {
      let datastore: DataStore | undefined;
      let retentionRequired = false;
      try {
        const drained = accumulator.drain(owner, input);
        if (drained.status === 'discarded') return drained;
        const hasCommitWork =
          drained.status === 'poisoned' ||
          drained.input.sessions.length > 0 ||
          drained.input.run !== undefined ||
          drained.reportEffect !== undefined;
        if (!hasCommitWork) return { status: 'discarded' };

        datastore = safeDatastore();
        if (datastore === undefined) return { status: 'datastore-unavailable' };
        retentionRequired = true;
        if (drained.status === 'poisoned') {
          log.warn?.({
            evt: 'cli.run-evidence.bundle_discarded',
            module: MODULE_TAG,
            reason: drained.reason,
          });
          return drained;
        }
        const committed = await commitDrainedEvidence(datastore, drained);
        return committed;
      } finally {
        if (retentionRequired && datastore !== undefined) enforceRetentionOnce(datastore);
        accumulator.discard(owner);
      }
    })();
    finalizations.set(owner, pending);
    return pending;
  }

  const factory: RunPlaneFactory = {
    beginRun() {
      invocation ??= makeInvocation();
      return invocation;
    },
    current() {
      invocation ??= makeInvocation();
      return invocation;
    },
    reset() {
      invocation = undefined;
    },
    queueReportEffect(effect) {
      return accumulator.queueReportEffect(factory.current().owner, effect);
    },
    finalizeCurrent(input) {
      const current = factory.current();
      if (accumulator.ownerKind(current.owner) === 'nested') {
        return Promise.resolve({ status: 'deferred' });
      }
      return finalizeOwner(current.owner, input);
    },
    createNestedEvidenceOwner() {
      return accumulator.createOwner('nested');
    },
    finalizeEvidenceOwner(owner, input) {
      return finalizeOwner(owner, input);
    },
    discardEvidenceOwner(owner) {
      accumulator.discard(owner);
    },
    replaceEvidenceOwnerReportEffect(owner, effect) {
      return accumulator.replaceReportEffect(owner, effect);
    },
  };
  return factory;
}
