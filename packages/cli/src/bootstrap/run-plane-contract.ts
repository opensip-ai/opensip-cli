/**
 * Host run-plane contracts shared by the lifecycle factory and command mounts.
 */

import type {
  HostEvidenceAccumulatorLimits,
  HostEvidenceOwnerToken,
} from './host-evidence-accumulator.js';
import type { DeferredReportEffect } from './report-open-policy.js';
import type { ResolvedSessionRetentionPolicy } from './session-retention.js';
import type { StoredSession, StoredSessionHostMetrics } from '@opensip-cli/contracts';
import type {
  EvidenceSnapshotContribution,
  Logger,
  RunLifecycle,
  ToolRunCompletion,
  ToolSessionContribution,
} from '@opensip-cli/core';
import type { DataStore } from '@opensip-cli/datastore';
import type {
  EvidenceBundleCommitResult,
  EvidenceBundlePrecondition,
  EvidenceBundleRun,
  commitEvidenceBundle,
} from '@opensip-cli/session-store';

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
