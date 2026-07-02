/**
 * @fileoverview one-trust-policy-pdp — local trust policy must have one pure
 * PDP in @opensip-cli/config. CLI files may adapt facts into requests, record
 * audit events, and translate deny/conditioned outcomes, but must not re-encode
 * strict/default policy rules.
 */
import { defineCheck } from '@opensip-cli/fitness';

const TEST_OR_DOC_PATH = /(?:\.test\.tsx?$|\/__tests__\/|^docs\/)/;
const POLICY_MODULE = /packages\/config\/src\/policy\//;
const EVALUATOR = /packages\/config\/src\/policy\/trust-policy-evaluator\.ts$/;

export function analyzeOneTrustPolicyPdp(content, filePath) {
  if (TEST_OR_DOC_PATH.test(filePath)) return [];
  if (!filePath.endsWith('.ts') && !filePath.endsWith('.tsx')) return [];

  const violations = [];
  if (!EVALUATOR.test(filePath) && /\b(?:function|const)\s+evaluateTrustPolicy\b/.test(content)) {
    violations.push({
      severity: 'error',
      line: lineOf(content, 'evaluateTrustPolicy'),
      message:
        'Trust policy must have one pure PDP: evaluateTrustPolicy belongs only in packages/config/src/policy/trust-policy-evaluator.ts.',
      suggestion:
        'Move policy rule logic into @opensip-cli/config and keep CLI/tool code as thin PEP adapters.',
    });
  }

  if (!POLICY_MODULE.test(filePath)) {
    const lines = content.split('\n');
    for (const [index, line] of lines.entries()) {
      if (line.includes("policy.mode === 'strict'") || line.includes('strict mode requires')) {
        violations.push({
          severity: 'error',
          line: index + 1,
          message:
            'Strict/default trust-policy rules must not be re-encoded outside @opensip-cli/config.',
          suggestion:
            'Call evaluateTrustPolicy/evaluatePolicyPep and translate the returned decision instead of branching on policy.mode.',
        });
      }
    }
  }

  return violations;
}

function lineOf(content, needle) {
  const before = content.slice(0, Math.max(0, content.indexOf(needle)));
  return before.split('\n').length;
}

export const checks = [
  defineCheck({
    id: '3a6182e5-96c0-4501-b0c7-93c94e46ab49',
    slug: 'one-trust-policy-pdp',
    description:
      'Trust policy decisions must flow through one pure PDP in @opensip-cli/config; CLI code stays as thin policy-enforcement adapters.',
    scope: { languages: ['typescript'], concerns: ['backend'] },
    tags: ['architecture', 'security'],
    fileTypes: ['ts', 'tsx'],
    contentFilter: 'strip-strings',
    analyze: (content, filePath) => analyzeOneTrustPolicyPdp(content, filePath),
  }),
];
