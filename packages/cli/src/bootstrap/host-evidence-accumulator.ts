import {
  MAX_EVIDENCE_BUNDLE_BYTES,
  MAX_EVIDENCE_BUNDLE_SESSIONS,
  measureEvidenceBundleBytes,
  type EvidenceBundleInput,
  type EvidenceBundlePrecondition,
  type EvidenceBundleRun,
  type EvidenceBundleSession,
} from '@opensip-cli/session-store';

import type { DeferredReportEffect } from './report.js';
import type { StoredSession, StoredSessionHostMetrics } from '@opensip-cli/contracts';

/** Host buffer limits intentionally match the atomic session-store boundary. */
export const MAX_HOST_EVIDENCE_SESSIONS = MAX_EVIDENCE_BUNDLE_SESSIONS;
export const MAX_HOST_EVIDENCE_BYTES = MAX_EVIDENCE_BUNDLE_BYTES;
const INVALID_EVIDENCE = 'invalid-evidence';

declare const evidenceOwnerBrand: unique symbol;

/** Opaque capability identifying one ordinary action or one nested suite. */
export interface HostEvidenceOwnerToken {
  readonly [evidenceOwnerBrand]: true;
}

export type HostEvidenceOwnerKind = 'ordinary' | 'nested';
export type HostEvidencePoisonReason = 'session-limit' | 'byte-limit' | 'invalid-evidence';

export interface HostEvidenceAccumulatorLimits {
  readonly maxSessions?: number;
  readonly maxBytes?: number;
}

export type HostEvidenceDrainResult =
  | {
      readonly status: 'drained';
      readonly input: EvidenceBundleInput;
      readonly reportEffect?: DeferredReportEffect;
    }
  | {
      readonly status: 'poisoned';
      readonly reason: HostEvidencePoisonReason;
    }
  | {
      readonly status: 'discarded';
    };

interface EvidenceOwnerState {
  readonly kind: HostEvidenceOwnerKind;
  lifecycle: 'active' | 'poisoned' | 'drained' | 'discarded';
  poisonReason?: HostEvidencePoisonReason;
  sessions: EvidenceBundleSession[];
  reportEffect?: DeferredReportEffect;
  drained?: HostEvidenceDrainResult;
}

export interface HostEvidenceAccumulator {
  readonly createOwner: (kind: HostEvidenceOwnerKind) => HostEvidenceOwnerToken;
  readonly ownerKind: (owner: HostEvidenceOwnerToken) => HostEvidenceOwnerKind | undefined;
  readonly stageSession: (
    owner: HostEvidenceOwnerToken,
    session: StoredSession,
    hostMetrics?: StoredSessionHostMetrics,
  ) => boolean;
  readonly mergeHostMetrics: (
    owner: HostEvidenceOwnerToken,
    sessionId: string,
    metrics: StoredSessionHostMetrics,
  ) => boolean;
  readonly isSessionLinkable: (owner: HostEvidenceOwnerToken, sessionId: string) => boolean;
  readonly stagedSession: (
    owner: HostEvidenceOwnerToken,
    sessionId: string,
  ) => StoredSession | undefined;
  readonly discardSession: (owner: HostEvidenceOwnerToken, sessionId: string) => boolean;
  readonly queueReportEffect: (
    owner: HostEvidenceOwnerToken,
    effect: DeferredReportEffect,
  ) => boolean;
  readonly replaceReportEffect: (
    owner: HostEvidenceOwnerToken,
    effect: DeferredReportEffect,
  ) => boolean;
  readonly drain: (
    owner: HostEvidenceOwnerToken,
    input?: {
      readonly run?: EvidenceBundleRun;
      readonly precondition?: EvidenceBundlePrecondition;
    },
  ) => HostEvidenceDrainResult;
  readonly discard: (owner: HostEvidenceOwnerToken) => void;
}

/**
 * Bounded, memory-only host evidence buffer.
 *
 * Any rejected contribution poisons its complete owner and clears all buffered
 * rows. The buffer therefore has no prefix-commit mode and never spills
 * customer evidence to a temporary file.
 */
export function createHostEvidenceAccumulator(
  limits: HostEvidenceAccumulatorLimits = {},
): HostEvidenceAccumulator {
  const maxSessions = limits.maxSessions ?? MAX_HOST_EVIDENCE_SESSIONS;
  const maxBytes = limits.maxBytes ?? MAX_HOST_EVIDENCE_BYTES;
  if (
    !Number.isSafeInteger(maxSessions) ||
    maxSessions < 0 ||
    maxSessions > MAX_HOST_EVIDENCE_SESSIONS
  ) {
    throw new RangeError(
      `maxSessions must be a safe integer between 0 and ${MAX_HOST_EVIDENCE_SESSIONS}`,
    );
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_HOST_EVIDENCE_BYTES) {
    throw new RangeError(
      `maxBytes must be a safe integer between 0 and ${MAX_HOST_EVIDENCE_BYTES}`,
    );
  }

  const owners = new WeakMap<HostEvidenceOwnerToken, EvidenceOwnerState>();

  function stateFor(owner: HostEvidenceOwnerToken): EvidenceOwnerState | undefined {
    return owners.get(owner);
  }

  function poison(state: EvidenceOwnerState, reason: HostEvidencePoisonReason): false {
    if (state.lifecycle === 'active') {
      state.lifecycle = 'poisoned';
      state.poisonReason = reason;
      state.sessions = [];
      state.reportEffect = undefined;
    }
    return false;
  }

  function measureCandidate(state: EvidenceOwnerState, candidate: EvidenceBundleInput): boolean {
    try {
      if (measureEvidenceBundleBytes(candidate) > maxBytes) {
        return poison(state, 'byte-limit');
      }
      return true;
    } catch {
      return poison(state, INVALID_EVIDENCE);
    }
  }

  function activeState(owner: HostEvidenceOwnerToken): EvidenceOwnerState | undefined {
    const state = stateFor(owner);
    return state?.lifecycle === 'active' ? state : undefined;
  }

  function isSessionLinkable(owner: HostEvidenceOwnerToken, sessionId: string): boolean {
    const state = stateFor(owner);
    return (
      (state?.lifecycle === 'active' || state?.lifecycle === 'drained') &&
      state.sessions.some((entry) => entry.session.id === sessionId)
    );
  }

  return {
    createOwner(kind) {
      const owner = Object.freeze({}) as HostEvidenceOwnerToken;
      owners.set(owner, { kind, lifecycle: 'active', sessions: [] });
      return owner;
    },

    ownerKind(owner) {
      return stateFor(owner)?.kind;
    },

    stageSession(owner, session, hostMetrics = {}) {
      const state = activeState(owner);
      if (state === undefined) return false;
      if (state.sessions.length >= maxSessions) return poison(state, 'session-limit');

      let immutableSession: StoredSession;
      let immutableMetrics: StoredSessionHostMetrics;
      try {
        immutableSession = immutableJsonClone(session);
        immutableMetrics = immutableJsonClone(hostMetrics);
      } catch {
        return poison(state, INVALID_EVIDENCE);
      }
      const entry = Object.freeze({
        session: immutableSession,
        hostMetrics: immutableMetrics,
      });
      const sessions = [...state.sessions, entry];
      if (!measureCandidate(state, { sessions })) return false;
      state.sessions = sessions;
      return true;
    },

    mergeHostMetrics(owner, sessionId, metrics) {
      const state = activeState(owner);
      if (state === undefined) return false;
      const index = state.sessions.findIndex((entry) => entry.session.id === sessionId);
      if (index < 0) return false;

      let merged: StoredSessionHostMetrics;
      try {
        merged = immutableJsonClone({ ...state.sessions[index].hostMetrics, ...metrics });
      } catch {
        return poison(state, INVALID_EVIDENCE);
      }
      const sessions = [...state.sessions];
      sessions[index] = Object.freeze({
        session: sessions[index].session,
        hostMetrics: merged,
      });
      if (!measureCandidate(state, { sessions })) return false;
      state.sessions = sessions;
      return true;
    },

    isSessionLinkable(owner, sessionId) {
      return isSessionLinkable(owner, sessionId);
    },

    stagedSession(owner, sessionId) {
      if (!isSessionLinkable(owner, sessionId)) return;
      return stateFor(owner)?.sessions.find((entry) => entry.session.id === sessionId)?.session;
    },

    discardSession(owner, sessionId) {
      const state = activeState(owner);
      if (state === undefined) return false;
      const next = state.sessions.filter((entry) => entry.session.id !== sessionId);
      if (next.length === state.sessions.length) return false;
      state.sessions = next;
      return true;
    },

    queueReportEffect(owner, effect) {
      const state = activeState(owner);
      if (state === undefined) return false;
      state.reportEffect ??= immutableJsonClone(effect);
      return true;
    },

    replaceReportEffect(owner, effect) {
      const state = activeState(owner);
      if (state === undefined) return false;
      try {
        state.reportEffect = immutableJsonClone(effect);
        return true;
      } catch {
        return false;
      }
    },

    drain(owner, drainInput = {}) {
      const state = stateFor(owner);
      if (state === undefined || state.lifecycle === 'discarded') {
        return { status: 'discarded' };
      }
      if (state.lifecycle === 'drained') {
        return state.drained ?? { status: 'discarded' };
      }
      if (state.lifecycle === 'poisoned') {
        return { status: 'poisoned', reason: state.poisonReason ?? INVALID_EVIDENCE };
      }

      let run: EvidenceBundleRun | undefined;
      try {
        run = drainInput.run === undefined ? undefined : immutableJsonClone(drainInput.run);
      } catch {
        poison(state, INVALID_EVIDENCE);
        return { status: 'poisoned', reason: INVALID_EVIDENCE };
      }
      const input: EvidenceBundleInput = Object.freeze({
        sessions: Object.freeze([...state.sessions]),
        ...(run === undefined ? {} : { run }),
        ...(drainInput.precondition === undefined ? {} : { precondition: drainInput.precondition }),
      });
      if (!measureCandidate(state, input)) {
        return { status: 'poisoned', reason: state.poisonReason ?? INVALID_EVIDENCE };
      }

      const drained: HostEvidenceDrainResult = Object.freeze({
        status: 'drained',
        input,
        ...(state.reportEffect === undefined ? {} : { reportEffect: state.reportEffect }),
      });
      state.lifecycle = 'drained';
      state.drained = drained;
      return drained;
    },

    discard(owner) {
      const state = stateFor(owner);
      if (state === undefined) return;
      state.lifecycle = 'discarded';
      state.sessions = [];
      state.reportEffect = undefined;
      state.drained = undefined;
      owners.delete(owner);
    },
  };
}

function immutableJsonClone<T>(value: T): T {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new TypeError('Evidence must be JSON serializable.');
  }
  return deepFreeze(JSON.parse(serialized) as T);
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}
