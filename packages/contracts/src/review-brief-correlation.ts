import {
  compareReviewBriefCorrelationGroups,
  compareReviewBriefCorrelationRisks,
  reviewBriefCorrelationMemberSignature,
} from './review-brief-correlation-order.js';
import {
  REVIEW_BRIEF_CORRELATION_ENTITY_LIMIT,
  REVIEW_BRIEF_CORRELATION_GROUP_LIMIT,
  REVIEW_BRIEF_CORRELATION_MEMBER_LIMIT,
  REVIEW_BRIEF_CORRELATION_REASON_LIMIT,
} from './review-brief-correlation-types.js';

export {
  reviewBriefCorrelationGroupSchema,
  reviewBriefCorrelationKeySchema,
  reviewBriefCorrelationReasonSchema,
  reviewBriefEntityRefSchema,
  reviewBriefRiskRefSchema,
} from './review-brief-correlation-schemas.js';
export {
  reviewBriefCorrelationKeys,
  reviewBriefEntities,
} from './review-brief-correlation-projection.js';
export {
  REVIEW_BRIEF_CORRELATION_ENTITY_LIMIT,
  REVIEW_BRIEF_CORRELATION_GROUP_LIMIT,
  REVIEW_BRIEF_CORRELATION_KEY_LIMIT,
  REVIEW_BRIEF_CORRELATION_MEMBER_LIMIT,
  REVIEW_BRIEF_CORRELATION_REASON_LIMIT,
} from './review-brief-correlation-types.js';
export type {
  BuildReviewBriefCorrelationsOptions,
  ReviewBriefCorrelationBlastRadius,
  ReviewBriefCorrelationGroup,
  ReviewBriefCorrelationKey,
  ReviewBriefCorrelationKeyKind,
  ReviewBriefCorrelationReason,
  ReviewBriefCorrelationRisk,
  ReviewBriefCorrelationSignalRef,
  ReviewBriefEntityRef,
  ReviewBriefRiskRef,
} from './review-brief-correlation-types.js';

import type {
  BuildReviewBriefCorrelationsOptions,
  ReviewBriefCorrelationBlastRadius,
  ReviewBriefCorrelationGroup,
  ReviewBriefCorrelationKey,
  ReviewBriefCorrelationReason,
  ReviewBriefCorrelationRisk,
  ReviewBriefEntityRef,
  ReviewBriefRiskRef,
} from './review-brief-correlation-types.js';

interface CorrelatedRiskBucket {
  readonly key: ReviewBriefCorrelationKey;
  readonly risks: ReviewBriefCorrelationRisk[];
}

const reasonKindByKeyKind: Readonly<
  Record<ReviewBriefCorrelationKey['kind'], ReviewBriefCorrelationReason['kind']>
> = {
  fingerprint: 'same-fingerprint',
  'graph-node': 'same-graph-node',
  symbol: 'same-symbol',
  'rule-location': 'same-rule-location',
  'file-range': 'same-file-range',
  package: 'same-package',
  file: 'same-file',
};

function riskRef(risk: ReviewBriefCorrelationRisk): ReviewBriefRiskRef {
  return {
    source: risk.source,
    ruleId: risk.ruleId,
    file: risk.file,
    signalRef: risk.signalRef,
    ...(risk.line === undefined ? {} : { line: risk.line }),
    ...(risk.column === undefined ? {} : { column: risk.column }),
  };
}

function reasonForKey(key: ReviewBriefCorrelationKey): ReviewBriefCorrelationReason {
  return {
    kind: reasonKindByKeyKind[key.kind],
    key,
    confidence: key.confidence,
    message: `Risks share ${key.kind} correlation key '${key.value}'.`,
  };
}

function titleForKey(key: ReviewBriefCorrelationKey): string {
  if (key.kind === 'symbol') return `Related findings for symbol ${key.value}`;
  if (key.kind === 'graph-node') return `Related findings for graph node ${key.value}`;
  if (key.kind === 'package') return `Related findings in package ${key.value}`;
  if (key.kind === 'file') return `Related findings in ${key.value}`;
  if (key.kind === 'file-range') return `Related findings at ${key.value}`;
  if (key.kind === 'fingerprint') return `Repeated evidence for fingerprint ${key.value}`;
  return `Related findings at ${key.value}`;
}

function isSlugChar(char: string): boolean {
  return (char >= 'a' && char <= 'z') || (char >= '0' && char <= '9');
}

function safeIdPart(value: string): string {
  let out = '';
  let pendingDash = false;
  for (const char of value.toLowerCase()) {
    if (isSlugChar(char)) {
      if (pendingDash && out.length > 0) out += '-';
      out += char;
      pendingDash = false;
    } else if (out.length > 0) {
      pendingDash = true;
    }
    if (out.length >= 80) break;
  }
  return out || 'unknown';
}

function groupId(key: ReviewBriefCorrelationKey): string {
  return `corr-${key.kind}-${safeIdPart(key.value)}`;
}

function collectEntities(
  risks: readonly ReviewBriefCorrelationRisk[],
  limit: number,
): readonly ReviewBriefEntityRef[] {
  const out: ReviewBriefEntityRef[] = [];
  for (const risk of risks) {
    for (const entity of risk.entities ?? []) {
      if (out.some((existing) => existing.kind === entity.kind && existing.id === entity.id))
        continue;
      if (out.length >= limit) return out;
      out.push(entity);
    }
  }
  return out;
}

function strongestBlastRadius(
  risks: readonly ReviewBriefCorrelationRisk[],
): ReviewBriefCorrelationBlastRadius | undefined {
  let best: ReviewBriefCorrelationBlastRadius | undefined;
  for (const risk of risks) {
    const current = risk.blastRadius;
    if (current === undefined) continue;
    if (best === undefined || current.dependents > best.dependents) {
      best = current;
    }
  }
  return best;
}

function optionLimit(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : fallback;
}

function bucketRisksByKey(
  risks: readonly ReviewBriefCorrelationRisk[],
): Map<string, CorrelatedRiskBucket> {
  const byKey = new Map<string, CorrelatedRiskBucket>();
  for (const risk of risks) {
    for (const key of risk.correlationKeys ?? []) {
      const mapKey = `${key.kind}\0${key.value}`;
      const existing = byKey.get(mapKey);
      if (existing === undefined) byKey.set(mapKey, { key, risks: [risk] });
      else existing.risks.push(risk);
    }
  }
  return byKey;
}

function nextGroupId(key: ReviewBriefCorrelationKey, usedIds: Map<string, number>): string {
  const idBase = groupId(key);
  const idCount = usedIds.get(idBase) ?? 0;
  usedIds.set(idBase, idCount + 1);
  return idCount === 0 ? idBase : `${idBase}-${String(idCount + 1)}`;
}

function buildGroup(input: {
  readonly key: ReviewBriefCorrelationKey;
  readonly risks: readonly ReviewBriefCorrelationRisk[];
  readonly usedIds: Map<string, number>;
  readonly memberLimit: number;
  readonly entityLimit: number;
  readonly reasonLimit: number;
}): ReviewBriefCorrelationGroup | undefined {
  if (input.risks.length < 2) return undefined;
  const sorted = [...input.risks];
  sorted.sort(compareReviewBriefCorrelationRisks);
  const primary = sorted[0];
  if (primary === undefined) return undefined;
  const blastRadius = strongestBlastRadius(sorted);
  return {
    id: nextGroupId(input.key, input.usedIds),
    title: titleForKey(input.key),
    severity: primary.severity,
    isNew: sorted.some((risk) => risk.isNew),
    primary: riskRef(primary),
    members: sorted.slice(0, input.memberLimit).map(riskRef),
    entities: collectEntities(sorted, input.entityLimit),
    reasons: [reasonForKey(input.key)].slice(0, input.reasonLimit),
    ...(blastRadius === undefined ? {} : { blastRadius }),
  };
}

function dedupeGroupsByMemberSet(
  groups: readonly ReviewBriefCorrelationGroup[],
): readonly ReviewBriefCorrelationGroup[] {
  const sortedGroups = [...groups];
  sortedGroups.sort(compareReviewBriefCorrelationGroups);
  const byMemberSet = new Set<string>();
  const deduped: ReviewBriefCorrelationGroup[] = [];
  for (const group of sortedGroups) {
    const signature = reviewBriefCorrelationMemberSignature(group);
    if (byMemberSet.has(signature)) continue;
    byMemberSet.add(signature);
    deduped.push(group);
  }
  return deduped;
}

/** Build bounded, explainable correlation groups from review-brief risks. */
export function buildReviewBriefCorrelations(
  risks: readonly ReviewBriefCorrelationRisk[],
  options: BuildReviewBriefCorrelationsOptions = {},
): readonly ReviewBriefCorrelationGroup[] {
  const memberLimit = optionLimit(options.memberLimit, REVIEW_BRIEF_CORRELATION_MEMBER_LIMIT);
  const entityLimit = optionLimit(options.entityLimit, REVIEW_BRIEF_CORRELATION_ENTITY_LIMIT);
  const reasonLimit = optionLimit(options.reasonLimit, REVIEW_BRIEF_CORRELATION_REASON_LIMIT);
  const groups: ReviewBriefCorrelationGroup[] = [];
  const usedIds = new Map<string, number>();

  for (const { key, risks: groupRisks } of bucketRisksByKey(risks).values()) {
    const group = buildGroup({
      key,
      risks: groupRisks,
      usedIds,
      memberLimit,
      entityLimit,
      reasonLimit,
    });
    if (group !== undefined) groups.push(group);
  }

  const groupLimit = optionLimit(options.groupLimit, REVIEW_BRIEF_CORRELATION_GROUP_LIMIT);
  return dedupeGroupsByMemberSet(groups).slice(0, groupLimit);
}
