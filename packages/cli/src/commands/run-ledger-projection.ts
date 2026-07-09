import type { SignalEnvelope } from '@opensip-cli/contracts';

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

export function projectEnvelopeEvidence(envelope: SignalEnvelope | undefined): unknown {
  if (envelope === undefined) return undefined;
  const fingerprints = envelope.signals
    .map((signal) => signal.fingerprint)
    .filter((fingerprint): fingerprint is string => typeof fingerprint === 'string')
    .slice(0, 20);
  return {
    schemaVersion: envelope.schemaVersion,
    tool: envelope.tool,
    runId: envelope.runId,
    createdAt: envelope.createdAt,
    verdict: {
      passed: envelope.verdict.passed,
      faulted: envelope.verdict.faulted === true,
      score: envelope.verdict.score,
      errors: envelope.verdict.summary.errors,
      warnings: envelope.verdict.summary.warnings,
      total: envelope.verdict.summary.total,
    },
    signalCount: envelope.signals.length,
    unitCount: envelope.units.length,
    ...(fingerprints.length === 0 ? {} : { fingerprints }),
    ...(envelope.resolutionMode === undefined ? {} : { resolutionMode: envelope.resolutionMode }),
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
