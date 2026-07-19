import { isSignalEnvelope } from '@opensip-cli/contracts';

import type { StagedEnvelopeEvidence } from './run-plane-contract.js';
import type { SignalEnvelope } from '@opensip-cli/contracts';
import type { ToolRunCompletion } from '@opensip-cli/core';

/** Strip the host-owned Session contribution after it has been staged. */
export function completionWithoutSession(completion: ToolRunCompletion): ToolRunCompletion {
  return {
    ...(completion.result === undefined ? {} : { result: completion.result }),
    ...(completion.envelope === undefined ? {} : { envelope: completion.envelope }),
    ...(completion.evidenceSnapshots === undefined
      ? {}
      : { evidenceSnapshots: completion.evidenceSnapshots }),
    ...(completion.execution === undefined ? {} : { execution: completion.execution }),
  };
}

/** Capture a bounded immutable projection of a returned SignalEnvelope. */
export function captureEnvelopeEvidence(value: unknown): StagedEnvelopeEvidence | undefined {
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
