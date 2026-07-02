/**
 * @fileoverview impact-trust-conservative-fallback — `fit --include-impacted`
 *               must not silently degrade to changed-only when graph impact
 *               evidence is unavailable or uncertain. Project-local SELF-check.
 *
 * This check is opensip-cli-specific: it hardcodes the first-party fitness
 * changed-targeting path and enforces the product trust rule from the impact
 * analysis trust foundation. Consumer repositories do not have this file path or
 * architecture concern, so it belongs in the project-local checks.
 */
import { defineCheck } from '@opensip-cli/fitness';

const TARGET_PATH = 'packages/fitness/engine/src/cli/fit/changed-targeting.ts';

export function analyzeImpactTrustConservativeFallback(content, filePath) {
  const normalized = filePath.replaceAll('\\', '/');
  if (!normalized.endsWith(TARGET_PATH)) return [];

  const violations = [];
  if (/changed-only\s*\(graph catalog unavailable\)/.test(content)) {
    violations.push({
      message:
        '`fit --include-impacted` must not degrade to changed-only when the graph catalog is unavailable.',
      severity: 'error',
      line: 1,
      column: 1,
      suggestion:
        'Return an impact trust fallback with fallback: "full-run" and let fit run the full target set.',
    });
  }
  if (!content.includes("fallback: 'full-run'") || !content.includes('graph-catalog-unavailable')) {
    violations.push({
      message:
        '`fit --include-impacted` must have an explicit full-run fallback for unavailable graph impact evidence.',
      severity: 'error',
      line: 1,
      column: 1,
      suggestion:
        'Build ImpactTrust with fallback: "full-run" for unavailable/partial graph evidence and surface a warning.',
    });
  }
  return violations;
}

export const checks = [
  defineCheck({
    id: 'e7f23cc7-50f2-4f2f-92bb-e5059521d8c9',
    slug: 'impact-trust-conservative-fallback',
    description:
      '`fit --include-impacted` must full-run fallback when graph impact trust is unavailable or uncertain',
    scope: { languages: ['typescript'], concerns: ['backend'] },
    tags: ['architecture', 'quality'],
    fileTypes: ['ts'],
    contentFilter: 'raw',
    analyze: (content, filePath) => analyzeImpactTrustConservativeFallback(content, filePath),
  }),
];
