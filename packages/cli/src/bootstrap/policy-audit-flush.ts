import { parsePolicySubject } from '@opensip-cli/config';
import { currentScope, logger } from '@opensip-cli/core';
import {
  PolicyAuditRepo,
  type DataStore,
  type PolicyAuditAppendEvent,
} from '@opensip-cli/datastore';

import { isPolicyAuditCollector, type BufferedPolicyAuditEvent } from './policy-audit.js';

const POLICY_AUDIT_MODULE = 'cli:policy-audit';
const POLICY_AUDIT_FLUSH_SKIPPED = 'policy.audit.flush.skipped';

export function flushPolicyAuditEvents(datastore?: DataStore): number {
  const scope = currentScope();
  const audit = scope === undefined ? undefined : scope.policyAudit;
  if (!isPolicyAuditCollector(audit)) {
    logger.debug({
      evt: POLICY_AUDIT_FLUSH_SKIPPED,
      module: POLICY_AUDIT_MODULE,
      reason: 'collector-unavailable',
    });
    return 0;
  }

  const events = audit.list();
  if (events.length === 0) {
    logger.debug({
      evt: POLICY_AUDIT_FLUSH_SKIPPED,
      module: POLICY_AUDIT_MODULE,
      reason: 'empty',
    });
    return 0;
  }

  let target = datastore;
  if (target === undefined) {
    try {
      target = scope?.datastore() as DataStore | undefined;
    } catch (error) {
      logger.debug({
        evt: POLICY_AUDIT_FLUSH_SKIPPED,
        module: POLICY_AUDIT_MODULE,
        reason: 'datastore-unavailable',
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    }
  }
  if (target === undefined) return 0;

  try {
    const inserted = new PolicyAuditRepo(target).append(
      events.map((event) => toAppendEvent(event)),
    );
    audit.drain();
    logger.info({
      evt: 'policy.audit.flush.complete',
      module: POLICY_AUDIT_MODULE,
      count: inserted,
    });
    return inserted;
  } catch (error) {
    logger.warn({
      evt: 'policy.audit.flush.failed',
      module: POLICY_AUDIT_MODULE,
      count: events.length,
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
  }
}

function toAppendEvent(event: BufferedPolicyAuditEvent): PolicyAuditAppendEvent {
  const parsed = parsePolicySubject(event.subject);
  return {
    id: event.id,
    ...(event.runId === undefined ? {} : { runId: event.runId }),
    timestamp: event.occurredAt,
    subjectKind: parsed?.kind ?? 'unknown',
    subjectId: parsed?.id ?? event.subject,
    subject: parsed ?? { kind: 'unknown', id: event.subject },
    action: event.action,
    outcome: event.outcome,
    reasons: event.reasons,
    sourceTiers: [event.sourceTier],
    matchedExceptionIds: event.exceptionIds,
    metadata: event.metadata,
  };
}
