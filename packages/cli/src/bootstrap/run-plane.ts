/**
 * Host-owned run lifecycle and evidence staging.
 *
 * Tool handlers return a ToolSessionContribution. The host freezes lifecycle
 * timing, assigns identity, and stages a complete immutable StoredSession in a
 * bounded memory owner. The command boundary later commits that Session and its
 * optional parent Run atomically; analysis never holds a datastore write lock.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import {
  isSignalEnvelope,
  type SignalEnvelope,
  type StoredSession,
  type StoredSessionHostMetrics,
} from '@opensip-cli/contracts';
import {
  createRunLifecycle,
  currentScope,
  deriveRunOutcome,
  generatePrefixedId,
  logger as defaultLogger,
  readPackageVersion,
  type EvidenceSnapshotContribution,
  type Logger,
  type RunLifecycle,
  type ToolRunCompletion,
  type ToolRunSessions,
  type ToolSessionContribution,
} from '@opensip-cli/core';
import {
  commitEvidenceBundle,
  type EvidenceBundleCommitResult,
  type EvidenceBundlePrecondition,
  type EvidenceBundleRun,
} from '@opensip-cli/session-store';

import { manifestVersionFor } from './declared-inputs.js';
import { captureEvidenceSnapshots } from './evidence-snapshot-capture.js';
import {
  createHostEvidenceAccumulator,
  type HostEvidenceAccumulatorLimits,
  type HostEvidenceDrainResult,
  type HostEvidenceOwnerToken,
} from './host-evidence-accumulator.js';
import { type DeferredReportEffect } from './report.js';
import {
  enforceSessionRetention,
  resolveCurrentSessionRetentionPolicy,
  type ResolvedSessionRetentionPolicy,
} from './session-retention.js';

import type { DataStore } from '@opensip-cli/datastore';

const CLI_VERSION = readPackageVersion(import.meta.url);
const MODULE_TAG = 'cli:run-plane';

export interface SuiteRunContext {
  readonly suiteRunId: string;
  readonly suiteName: string;
  /**
   * Task 1.4 supplies this explicit nested owner. Until then, a suite context
   * without one retains the legacy per-step ordinary finalization behavior.
   */
  readonly evidenceOwner?: HostEvidenceOwnerToken;
}

const suiteContextStorage = new AsyncLocalStorage<SuiteRunContext>();

export function currentSuiteRunContext(): SuiteRunContext | undefined {
  return suiteContextStorage.getStore();
}

export function runWithSuiteRunContext<T>(ctx: SuiteRunContext, fn: () => T): T {
  return suiteContextStorage.run(ctx, fn);
}

export interface RunPlaneDeps {
  readonly getDatastore: () => DataStore | undefined;
  readonly sessionRetentionPolicy?: () => ResolvedSessionRetentionPolicy;
  readonly executeReportEffect?: (effect: DeferredReportEffect) => Promise<void>;
  readonly onReportEffectFailure?: (detail: {
    readonly effect: DeferredReportEffect;
    readonly errorName: string;
  }) => Promise<void>;
  readonly evidenceLimits?: HostEvidenceAccumulatorLimits;
  /** Test seam; production uses session-store's closed atomic API. */
  readonly commitEvidence?: typeof commitEvidenceBundle;
  readonly logger?: Logger;
}

export interface HostEvidenceFinalizeInput {
  readonly run?: EvidenceBundleRun;
  readonly precondition?: EvidenceBundlePrecondition;
}

export type HostEvidenceFinalizeResult =
  | EvidenceBundleCommitResult
  | {
      readonly status: 'deferred';
    }
  | {
      readonly status: 'poisoned';
      readonly reason: 'session-limit' | 'byte-limit' | 'invalid-evidence';
    }
  | {
      readonly status: 'datastore-unavailable' | 'discarded';
    };

export type RunSessionStagingStatus = 'none' | 'staged' | 'rejected' | 'discarded';

/** Immutable bounded envelope facts retained before any output side effect. */
export interface StagedEnvelopeEvidence {
  readonly tool: string;
  readonly createdAt: string;
  readonly engineVersion?: string;
  readonly passed: boolean;
  readonly faulted: boolean;
  readonly score: number;
  readonly errors: number;
  readonly warnings: number;
  readonly findings: number;
  readonly evidence: Readonly<Record<string, unknown>>;
}

export interface RunPlaneInvocation {
  readonly lifecycle: RunLifecycle;
  /** Freeze timing and stage one complete Session. Idempotent per invocation. */
  completeAndStage(contribution: ToolSessionContribution): StoredSession | undefined;
  /** Merge host-only metrics into the staged sibling row before drain. */
  recordHostMetrics(metrics: StoredSessionHostMetrics): void;
  /** Stage a live renderer's Session and strip only `.session` from its return. */
  completeLiveRender(
    render: () => Promise<ToolRunCompletion | void>,
  ): Promise<ToolRunCompletion | void>;
  /** Preallocated, still-linkable Session identity. */
  sessionId(): string | undefined;
  /** Immutable Session used by the pure standalone parent projection. */
  stagedSession(): StoredSession | undefined;
  /** Capture and expose bounded immutable envelope facts before output replay. */
  captureEnvelope(result: unknown): void;
  stagedEnvelope(): StagedEnvelopeEvidence | undefined;
  /** Remove only this invocation's staged Session from its owner. */
  discardEvidence(): void;
  /** Closed observation used by suite capability validation. */
  sessionStagingStatus(): RunSessionStagingStatus;
  readonly owner: HostEvidenceOwnerToken;
}

export interface RunActionHooks {
  readonly beginRun?: () => void;
  readonly completeRun?: (result: unknown) => void;
  readonly resetRun?: () => void;
  readonly currentSessionId?: () => string | undefined;
  readonly currentStagedSession?: () => StoredSession | undefined;
  readonly currentStagedEnvelope?: () => StagedEnvelopeEvidence | undefined;
  readonly currentSessionStagingStatus?: () => RunSessionStagingStatus;
  readonly currentEvidenceSnapshots?: () => readonly EvidenceSnapshotContribution[];
  /** Remove a capability-mismatched step's staged Session without poisoning siblings. */
  readonly discardCurrentInvocationEvidence?: () => void;
  /** Ordinary command-boundary finalizer; nested owners deliberately defer. */
  readonly finalizeRun?: (input?: HostEvidenceFinalizeInput) => Promise<HostEvidenceFinalizeResult>;
  /** Task 1.4 host-only nested owner capabilities. */
  readonly createNestedEvidenceOwner?: () => HostEvidenceOwnerToken;
  readonly finalizeEvidenceOwner?: (
    owner: HostEvidenceOwnerToken,
    input?: HostEvidenceFinalizeInput,
  ) => Promise<HostEvidenceFinalizeResult>;
  readonly discardEvidenceOwner?: (owner: HostEvidenceOwnerToken) => void;
  /** Replace child requests with one suite-owned exact post-commit effect. */
  readonly replaceEvidenceOwnerReportEffect?: (
    owner: HostEvidenceOwnerToken,
    effect?: DeferredReportEffect,
  ) => boolean;
  readonly maybeDispatchExternal?: (
    commandName: string,
    opts: Record<string, unknown>,
    positionals: readonly unknown[],
  ) => Promise<boolean>;
}

export interface RunPlaneFactory {
  beginRun(): RunPlaneInvocation;
  current(): RunPlaneInvocation;
  /**
   * Clear invocation-local timing and identity. Explicit nested-owner rows stay
   * in the accumulator for their sole owner to drain later.
   */
  reset(): void;
  queueReportEffect(effect: DeferredReportEffect): boolean;
  finalizeCurrent(input?: HostEvidenceFinalizeInput): Promise<HostEvidenceFinalizeResult>;
  createNestedEvidenceOwner(): HostEvidenceOwnerToken;
  finalizeEvidenceOwner(
    owner: HostEvidenceOwnerToken,
    input?: HostEvidenceFinalizeInput,
  ): Promise<HostEvidenceFinalizeResult>;
  discardEvidenceOwner(owner: HostEvidenceOwnerToken): void;
  replaceEvidenceOwnerReportEffect(
    owner: HostEvidenceOwnerToken,
    effect?: DeferredReportEffect,
  ): boolean;
}

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
        cwd: contribution.cwd,
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
        evt: 'session.retention.policy_resolved',
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
        'session.retention.policy_resolved',
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

function suiteSessionFields(): { suiteRunId?: string; suiteName?: string } {
  const suite = currentSuiteRunContext();
  return suite === undefined ? {} : { suiteRunId: suite.suiteRunId, suiteName: suite.suiteName };
}

export function createRunSessionSeam(factory: RunPlaneFactory): ToolRunSessions {
  return {
    get timing() {
      return factory.current().lifecycle;
    },
  };
}

export function createRunActionHooks(factory: RunPlaneFactory): RunActionHooks {
  let evidenceSnapshots: readonly EvidenceSnapshotContribution[] = Object.freeze([]);
  return {
    beginRun: () => {
      evidenceSnapshots = Object.freeze([]);
      factory.beginRun();
    },
    completeRun: (result) => {
      const completion = result as ToolRunCompletion | undefined;
      factory.current().captureEnvelope(result);
      evidenceSnapshots =
        completion?.evidenceSnapshots === undefined
          ? Object.freeze([])
          : captureEvidenceSnapshots(completion.evidenceSnapshots);
      if (completion?.session !== undefined) {
        factory.current().completeAndStage(completion.session);
      }
    },
    resetRun: () => {
      factory.reset();
      evidenceSnapshots = Object.freeze([]);
    },
    currentSessionId: () => factory.current().sessionId(),
    currentStagedSession: () => factory.current().stagedSession(),
    currentStagedEnvelope: () => factory.current().stagedEnvelope(),
    currentSessionStagingStatus: () => factory.current().sessionStagingStatus(),
    currentEvidenceSnapshots: () => evidenceSnapshots,
    discardCurrentInvocationEvidence: () => {
      factory.current().discardEvidence();
      evidenceSnapshots = Object.freeze([]);
    },
    finalizeRun: (input) => factory.finalizeCurrent(input),
    createNestedEvidenceOwner: () => factory.createNestedEvidenceOwner(),
    finalizeEvidenceOwner: (owner, input) => factory.finalizeEvidenceOwner(owner, input),
    discardEvidenceOwner: (owner) => factory.discardEvidenceOwner(owner),
    replaceEvidenceOwnerReportEffect: (owner, effect) =>
      factory.replaceEvidenceOwnerReportEffect(owner, effect),
  };
}

function completionWithoutSession(completion: ToolRunCompletion): ToolRunCompletion {
  return {
    ...(completion.result === undefined ? {} : { result: completion.result }),
    ...(completion.envelope === undefined ? {} : { envelope: completion.envelope }),
    ...(completion.evidenceSnapshots === undefined
      ? {}
      : { evidenceSnapshots: completion.evidenceSnapshots }),
    ...(completion.execution === undefined ? {} : { execution: completion.execution }),
  };
}

function captureEnvelopeEvidence(value: unknown): StagedEnvelopeEvidence | undefined {
  try {
    const envelope = extractEnvelope(value);
    if (envelope === undefined) return undefined;
    const { verdict } = envelope;
    const summary = verdict?.summary;
    if (
      typeof envelope.tool !== 'string' ||
      typeof envelope.runId !== 'string' ||
      typeof envelope.createdAt !== 'string' ||
      typeof verdict?.passed !== 'boolean' ||
      !finiteNumber(verdict.score) ||
      !finiteNumber(summary?.errors) ||
      !finiteNumber(summary.warnings) ||
      !finiteNumber(summary.total) ||
      !Array.isArray(envelope.signals) ||
      !Array.isArray(envelope.units)
    ) {
      return undefined;
    }

    const fingerprints: string[] = [];
    const scanCount = Math.min(envelope.signals.length, 100);
    for (let index = 0; index < scanCount && fingerprints.length < 20; index += 1) {
      const signal = envelope.signals[index] as unknown;
      if (signal === null || typeof signal !== 'object') continue;
      const fingerprint = (signal as { readonly fingerprint?: unknown }).fingerprint;
      if (typeof fingerprint === 'string') fingerprints.push(fingerprint);
    }
    const frozenFingerprints = Object.freeze(fingerprints);
    const faulted = verdict.faulted === true;
    const evidence = Object.freeze({
      kind: 'signal-envelope',
      schemaVersion: envelope.schemaVersion,
      tool: envelope.tool,
      runId: envelope.runId,
      createdAt: envelope.createdAt,
      verdict: Object.freeze({
        passed: verdict.passed,
        faulted,
        score: verdict.score,
        errors: summary.errors,
        warnings: summary.warnings,
        total: summary.total,
      }),
      signalCount: envelope.signals.length,
      unitCount: envelope.units.length,
      ...(frozenFingerprints.length === 0 ? {} : { fingerprints: frozenFingerprints }),
      ...(typeof envelope.resolutionMode === 'string'
        ? { resolutionMode: envelope.resolutionMode }
        : {}),
    });
    const engineVersion =
      typeof envelope.declaredInputs?.engineVersion === 'string'
        ? envelope.declaredInputs.engineVersion
        : undefined;
    return Object.freeze({
      tool: envelope.tool,
      createdAt: envelope.createdAt,
      ...(engineVersion === undefined ? {} : { engineVersion }),
      passed: verdict.passed,
      faulted,
      score: verdict.score,
      errors: summary.errors,
      warnings: summary.warnings,
      findings: envelope.signals.length,
      evidence,
    });
  } catch {
    return undefined;
  }
}

function extractEnvelope(value: unknown): SignalEnvelope | undefined {
  if (isSignalEnvelope(value)) return value;
  if (value === null || typeof value !== 'object') return undefined;
  const completion = value as ToolRunCompletion;
  if (isSignalEnvelope(completion.envelope)) return completion.envelope;
  if (
    completion.result !== undefined &&
    completion.result !== null &&
    typeof completion.result === 'object'
  ) {
    const nested = completion.result as { readonly envelope?: unknown };
    if (isSignalEnvelope(nested.envelope)) return nested.envelope;
  }
  return undefined;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
