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

/** Public projection — no operatorDetail, metadata allowlisted by definition. */
export function toPublicFailureProjection(envelope: FailureEnvelope): JsonRecord {
  const allow = new Set(envelope.definition.publicMetadataKeys);
  /** @type {Record<string, unknown>} */
  const meta: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(envelope.metadata)) {
    if (allow.has(k)) meta[k] = v;
  }
  return toJsonRecord({
    schemaVersion: envelope.schemaVersion,
    code: envelope.code,
    message: envelope.message,
    action: envelope.operatorAction,
    source: envelope.definition.source,
    responsibility: envelope.definition.defaultResponsibility,
    kind: envelope.definition.kind,
    retry: envelope.definition.retry,
    severity: envelope.definition.severity,
    known: envelope.known,
    ...(Object.keys(meta).length > 0 ? { metadata: meta } : {}),
    ...(envelope.aggregate
      ? { aggregate: envelope.aggregate.map((a) => toPublicFailureProjection(a)) }
      : {}),
  });
}

/** Machine / worker-safe projection (redacted metadata, no operatorDetail/stack). */
export function toMachineFailureProjection(envelope: FailureEnvelope): JsonRecord {
  return toJsonRecord({
    schemaVersion: envelope.schemaVersion,
    code: envelope.code,
    message: envelope.message,
    action: envelope.operatorAction,
    source: envelope.definition.source,
    responsibility: envelope.definition.defaultResponsibility,
    kind: envelope.definition.kind,
    retry: envelope.definition.retry,
    severity: envelope.definition.severity,
    exposure: envelope.definition.exposure,
    exitClass: envelope.definition.exitClass,
    known: envelope.known,
    ...(envelope.failureClass === undefined ? {} : { failureClass: envelope.failureClass }),
    metadata: sanitizeErrorMetadata(envelope.metadata),
    causes: envelope.causes.map((c) => ({
      message: c.message,
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
    ...(envelope.operatorDetail === undefined
      ? {}
      : { operatorDetail: truncate(envelope.operatorDetail, MAX_OPERATOR_DETAIL) }),
  });
}
