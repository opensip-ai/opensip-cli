/**
 * @fileoverview no-lossy-evidence-egress — ADR-0127 requires shared SARIF and
 * native egress to preserve OpenSIP evidence identity instead of dropping it at
 * the delivery boundary.
 */
import { defineCheck } from '@opensip-cli/fitness';

const SARIF_FORMATTER = /packages\/output\/src\/format\/signal-sarif\.ts$/;
const SIGNAL_BATCH = /packages\/core\/src\/types\/signal-batch\.ts$/;

export function analyzeNoLossyEvidenceEgress(content, filePath) {
  if (!filePath.endsWith('.ts')) return [];
  const violations = [];

  if (SARIF_FORMATTER.test(filePath)) {
    if (!content.includes('partialFingerprints') || !content.includes('opensipFingerprint')) {
      violations.push({
        severity: 'error',
        line: 1,
        message:
          'SARIF egress must preserve Signal.fingerprint as partialFingerprints.opensipFingerprint.',
        suggestion:
          'Map Signal.fingerprint in packages/output/src/format/signal-sarif.ts before emitting SARIF.',
      });
    }
    if (
      !content.includes('OPEN_SIP_SARIF_RESULT_SCHEMA') ||
      !content.includes('resultProperties')
    ) {
      violations.push({
        severity: 'error',
        line: 1,
        message: 'SARIF egress must carry bounded OpenSIP result properties.',
        suggestion:
          'Keep the bounded allowlist helper in signal-sarif.ts; do not dump arbitrary Signal.metadata.',
      });
    }
  }

  if (SIGNAL_BATCH.test(filePath) && !content.includes('readonly evidence?: SignalBatchEvidence')) {
    violations.push({
      severity: 'error',
      line: 1,
      message: 'Native SignalBatch egress must include the optional evidence authority header.',
      suggestion:
        'Keep SignalBatch.evidence optional and treat absence as external-untrusted in consumers.',
    });
  }

  return violations;
}

export const checks = [
  defineCheck({
    id: '09cb9820-fab5-4b4a-8728-a8ed55978c3d',
    slug: 'no-lossy-evidence-egress',
    description:
      'Evidence egress must preserve OpenSIP fingerprints and authority headers across SARIF and native SignalBatch paths.',
    scope: { languages: ['typescript'], concerns: ['backend'] },
    tags: ['architecture', 'security'],
    fileTypes: ['ts'],
    contentFilter: 'raw',
    analyze: (content, filePath) => analyzeNoLossyEvidenceEgress(content, filePath),
  }),
];
