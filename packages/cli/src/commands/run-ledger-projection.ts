import { isSignalEnvelope } from '@opensip-cli/contracts';

import type { EvidenceSnapshotContribution } from '@opensip-cli/core';

const OMIT_ARG_KEYS = new Set([
  'apiKey',
  'config',
  'cwd',
  'debug',
  'json',
  'open',
  'quiet',
  'reportTo',
  'verbose',
  '_args',
]);

const SECRET_PATTERN = /api[-_]?key|authorization|password|secret|token/i;
const MAX_STRING_LENGTH = 500;
const MAX_ARRAY_LENGTH = 50;
const MAX_OBJECT_KEYS = 50;
const MAX_DEPTH = 3;

export function projectLedgerArgs(
  opts: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> | undefined {
  const projected: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(opts).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (OMIT_ARG_KEYS.has(key) || value === undefined) continue;
    projected[key] = SECRET_PATTERN.test(key) ? '<redacted>' : sanitizeLedgerValue(value, 0);
  }
  return Object.keys(projected).length === 0 ? undefined : projected;
}

export function projectEnvelopeEvidence(envelope: unknown): unknown {
  try {
    if (!isSignalEnvelope(envelope) || envelope.schemaVersion !== 2) return undefined;
    const summary = envelope.verdict.summary;
    if (
      typeof envelope.verdict.passed !== 'boolean' ||
      !finiteNumber(envelope.verdict.score) ||
      summary === null ||
      typeof summary !== 'object' ||
      !finiteNumber(summary.errors) ||
      !finiteNumber(summary.warnings) ||
      !finiteNumber(summary.total)
    ) {
      return undefined;
    }
    const fingerprints: string[] = [];
    const scanCount = Math.min(envelope.signals.length, 100);
    for (let index = 0; index < scanCount && fingerprints.length < 20; index += 1) {
      const signal = envelope.signals[index] as unknown;
      if (signal === null || typeof signal !== 'object' || !('fingerprint' in signal)) continue;
      const fingerprint = (signal as { readonly fingerprint?: unknown }).fingerprint;
      if (typeof fingerprint === 'string') fingerprints.push(fingerprint);
    }
    return {
      kind: 'signal-envelope',
      schemaVersion: envelope.schemaVersion,
      tool: envelope.tool,
      runId: envelope.runId,
      createdAt: envelope.createdAt,
      verdict: {
        passed: envelope.verdict.passed,
        faulted: envelope.verdict.faulted === true,
        score: envelope.verdict.score,
        errors: summary.errors,
        warnings: summary.warnings,
        total: summary.total,
      },
      signalCount: envelope.signals.length,
      unitCount: envelope.units.length,
      ...(fingerprints.length === 0 ? {} : { fingerprints }),
      ...(envelope.resolutionMode === undefined ? {} : { resolutionMode: envelope.resolutionMode }),
    };
  } catch {
    return undefined;
  }
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Bounded metadata-only projection; snapshot payloads never enter the host ledger. */
export function projectEvidenceSnapshotEvidence(
  snapshots: readonly EvidenceSnapshotContribution[] | undefined,
): unknown {
  if (snapshots === undefined || snapshots.length === 0) return undefined;
  return {
    kind: 'evidence-snapshots',
    schemaVersion: 1,
    snapshots: snapshots.slice(0, 16).map((snapshot) => ({
      kind: snapshot.kind,
      status: snapshot.status,
      ...(snapshot.snapshotId === undefined ? {} : { snapshotId: snapshot.snapshotId }),
      ...(snapshot.snapshotSchemaVersion === undefined
        ? {}
        : { snapshotSchemaVersion: snapshot.snapshotSchemaVersion }),
      producer: snapshot.producer,
      freshness: snapshot.freshness,
      coverage: snapshot.coverage,
      ...(snapshot.inputs === undefined ? {} : { inputs: snapshot.inputs }),
      ...(snapshot.reasons === undefined
        ? {}
        : { reasonCodes: snapshot.reasons.map((reason) => reason.code) }),
      ...(snapshot.followUpReads === undefined ? {} : { followUpReads: snapshot.followUpReads }),
    })),
  };
}

function sanitizeLedgerValue(value: unknown, depth: number): unknown {
  if (value === null) return null;
  if (typeof value === 'string') {
    return value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}...` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_LENGTH).map((item) => sanitizeLedgerValue(item, depth + 1));
  }
  if (typeof value === 'object') {
    if (depth >= MAX_DEPTH) return '<object>';
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(0, MAX_OBJECT_KEYS)) {
      out[key] = SECRET_PATTERN.test(key) ? '<redacted>' : sanitizeLedgerValue(child, depth + 1);
    }
    return out;
  }
  if (typeof value === 'bigint' || typeof value === 'symbol') return value.toString();
  return Object.prototype.toString.call(value);
}
