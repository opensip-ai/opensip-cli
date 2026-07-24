/**
 * Wire-safe projections of a canonical {@link FailureEnvelope} (Plan 00 Phase 3).
 *
 * The normalizer (`failure-envelope.ts`) turns any thrown value into one
 * canonical envelope; this module is the egress layer that renders that envelope
 * for a specific audience without leaking anything the audience must not see:
 *
 * - `public`   — external egress: metadata allowlisted by definition, no operatorDetail.
 * - `machine`  — worker / JSON consumers: redacted metadata, exitClass + causes, no operatorDetail/stack.
 * - `operator` — local operator: machine projection plus operatorDetail (still no raw Error objects).
 */

import { sanitizeErrorMetadata } from './errors.js';
import { MAX_OPERATOR_DETAIL, truncate, type FailureEnvelope } from './failure-envelope.js';
import { toJsonRecord, type JsonRecord } from './json-value.js';
import { scrubText } from './safe-diagnostic-data.js';

function allowlistedMetadata(envelope: FailureEnvelope): Readonly<Record<string, unknown>> {
  const allow = new Set(envelope.definition.publicMetadataKeys);
  const metadata: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(envelope.metadata)) {
    if (allow.has(key)) metadata[key] = value;
  }
  return sanitizeErrorMetadata(metadata);
}

function outwardMessage(envelope: FailureEnvelope): string {
  if (envelope.definition.exposure === 'public') {
    return scrubText(envelope.message, 1000);
  }
  return envelope.definition.exposure === 'redacted'
    ? 'The operation failed.'
    : 'An unexpected internal failure occurred.';
}

/** Public projection — no operatorDetail, metadata allowlisted by definition. */
export function toPublicFailureProjection(envelope: FailureEnvelope): JsonRecord {
  const metadata = allowlistedMetadata(envelope);
  return toJsonRecord({
    schemaVersion: envelope.schemaVersion,
    code: envelope.code,
    message: outwardMessage(envelope),
    action: envelope.operatorAction,
    source: envelope.definition.source,
    responsibility: envelope.definition.defaultResponsibility,
    kind: envelope.definition.kind,
    retry: envelope.definition.retry,
    severity: envelope.definition.severity,
    known: envelope.known,
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    ...(envelope.aggregate
      ? { aggregate: envelope.aggregate.map((a) => toPublicFailureProjection(a)) }
      : {}),
  });
}

/** Machine / worker-safe projection (redacted metadata, no operatorDetail/stack). */
export function toMachineFailureProjection(envelope: FailureEnvelope): JsonRecord {
  const metadata = allowlistedMetadata(envelope);
  return toJsonRecord({
    schemaVersion: envelope.schemaVersion,
    code: envelope.code,
    message: outwardMessage(envelope),
    action: envelope.operatorAction,
    source: envelope.definition.source,
    responsibility: envelope.definition.defaultResponsibility,
    kind: envelope.definition.kind,
    retry: envelope.definition.retry,
    severity: envelope.definition.severity,
    exposure: envelope.definition.exposure,
    exitClass: envelope.definition.exitClass,
    owner: envelope.definition.owner,
    stability: envelope.definition.stability,
    lifecycle: envelope.definition.lifecycle,
    publicMetadataKeys: envelope.definition.publicMetadataKeys ?? [],
    known: envelope.known,
    ...(envelope.failureClass === undefined ? {} : { failureClass: envelope.failureClass }),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    causes: envelope.causes.map((c) => ({
      known: c.known,
      ...(c.code ? { code: c.code } : {}),
    })),
    ...(envelope.aggregate
      ? {
          aggregate: envelope.aggregate.map((a) => toMachineFailureProjection(a)),
          ...(envelope.aggregateTruncated ? { aggregateTruncated: true } : {}),
        }
      : {}),
  });
}

/** Local operator projection — may include operatorDetail; still no raw Error objects. */
export function toOperatorFailureProjection(envelope: FailureEnvelope): JsonRecord {
  return toJsonRecord({
    ...toMachineFailureProjection(envelope),
    message: scrubText(envelope.message, 1000),
    metadata: sanitizeErrorMetadata(envelope.metadata),
    ...(envelope.operatorDetail === undefined
      ? {}
      : {
          operatorDetail: scrubText(
            truncate(envelope.operatorDetail, MAX_OPERATOR_DETAIL),
            MAX_OPERATOR_DETAIL,
          ),
        }),
  });
}
