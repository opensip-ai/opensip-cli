import {
  type EvidenceSnapshotContribution,
  type ToolRunCompletion,
  type ToolRunSessions,
} from '@opensip-cli/core';

import { captureEvidenceSnapshots } from './evidence-snapshot-capture.js';

import type { RunActionHooks, RunPlaneFactory } from './run-plane-contract.js';

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
