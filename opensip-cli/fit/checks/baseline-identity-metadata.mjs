/**
 * ADR-0075: baseline meta must persist fingerprint strategy id/version.
 */
import { defineCheck } from '@opensip-cli/fitness';

const SCHEMA_PATH = /packages\/datastore\/src\/schema\/baseline\.ts$/;
const REPO_PATH = /packages\/datastore\/src\/baseline-repo\.ts$/;

export function analyzeBaselineIdentityMetadata(content, filePath) {
  const normalized = filePath.replaceAll('\\', '/');
  const violations = [];

  if (SCHEMA_PATH.test(normalized)) {
    if (!content.includes('fingerprintStrategyId')) {
      violations.push({
        message: 'toolBaselineMeta missing fingerprintStrategyId column',
        severity: 'error',
      });
    }
    if (!content.includes('fingerprintStrategyVersion')) {
      violations.push({
        message: 'toolBaselineMeta missing fingerprintStrategyVersion column',
        severity: 'error',
      });
    }
  }

  if (REPO_PATH.test(normalized)) {
    if (!content.includes('fingerprintStrategyId')) {
      violations.push({
        message: 'BaselineRepo.save does not persist strategy id',
        severity: 'error',
      });
    }
  }

  return violations;
}

export const checks = [
  defineCheck({
    id: 'b4e7c2a1-9f3d-4e8b-a6c5-1d2e3f4a5b6c',
    slug: 'baseline-identity-metadata',
    description:
      'Baseline meta schema and BaselineRepo.save persist fingerprint strategy metadata (ADR-0075).',
    scope: { languages: ['typescript'], concerns: ['backend'] },
    tags: ['architecture', 'state'],
    fileTypes: ['ts'],
    contentFilter: 'raw',
    analyze: (content, filePath) => analyzeBaselineIdentityMetadata(content, filePath),
  }),
];
