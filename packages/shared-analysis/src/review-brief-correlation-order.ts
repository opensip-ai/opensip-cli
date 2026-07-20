import {
  compareCodePoint,
  REVIEW_BRIEF_CORRELATION_KEY_PRIORITY as keyPriority,
  REVIEW_BRIEF_SEVERITY_RANK as severityRank,
} from '@opensip-cli/contracts';

import type {
  ReviewBriefCorrelationGroup,
  ReviewBriefCorrelationRisk,
} from '@opensip-cli/contracts';

export { compareCodePoint } from '@opensip-cli/contracts';

export function compareReviewBriefCorrelationRisks(
  left: ReviewBriefCorrelationRisk,
  right: ReviewBriefCorrelationRisk,
): number {
  const severity = severityRank[left.severity] - severityRank[right.severity];
  if (severity !== 0) return severity;
  if (left.isNew !== right.isNew) return left.isNew ? -1 : 1;
  const leftDependents = left.blastRadius?.dependents ?? 0;
  const rightDependents = right.blastRadius?.dependents ?? 0;
  if (leftDependents !== rightDependents) return rightDependents - leftDependents;
  const source = compareCodePoint(left.source, right.source);
  if (source !== 0) return source;
  const file = compareCodePoint(left.file, right.file);
  if (file !== 0) return file;
  const line = (left.line ?? Number.MAX_SAFE_INTEGER) - (right.line ?? Number.MAX_SAFE_INTEGER);
  if (line !== 0) return line;
  const column =
    (left.column ?? Number.MAX_SAFE_INTEGER) - (right.column ?? Number.MAX_SAFE_INTEGER);
  if (column !== 0) return column;
  const rule = compareCodePoint(left.ruleId, right.ruleId);
  if (rule !== 0) return rule;
  const fingerprint = compareCodePoint(
    left.signalRef.fingerprint ?? '',
    right.signalRef.fingerprint ?? '',
  );
  if (fingerprint !== 0) return fingerprint;
  const stepIndex = left.signalRef.stepIndex - right.signalRef.stepIndex;
  if (stepIndex !== 0) return stepIndex;
  return left.signalRef.signalIndex - right.signalRef.signalIndex;
}

function correlationPriority(group: ReviewBriefCorrelationGroup): number {
  const key = group.reasons[0]?.key;
  return key === undefined ? Number.MAX_SAFE_INTEGER : keyPriority[key.kind];
}

function groupMemberSignature(group: ReviewBriefCorrelationGroup): string {
  return group.members
    .map((member) => {
      const ref = member.signalRef;
      return [
        ref.tool,
        ref.suiteRunId,
        String(ref.stepIndex),
        String(ref.signalIndex),
        ref.runId ?? '',
        ref.fingerprint ?? '',
      ].join('\0');
    })
    .sort(compareCodePoint)
    .join('\u0001');
}

export function compareReviewBriefCorrelationGroups(
  left: ReviewBriefCorrelationGroup,
  right: ReviewBriefCorrelationGroup,
): number {
  const severity = severityRank[left.severity] - severityRank[right.severity];
  if (severity !== 0) return severity;
  if (left.isNew !== right.isNew) return left.isNew ? -1 : 1;
  const priority = correlationPriority(left) - correlationPriority(right);
  if (priority !== 0) return priority;
  const members = right.members.length - left.members.length;
  if (members !== 0) return members;
  return compareCodePoint(left.id, right.id);
}

export function reviewBriefCorrelationMemberSignature(group: ReviewBriefCorrelationGroup): string {
  return groupMemberSignature(group);
}
