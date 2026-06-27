/**
 * @fileoverview Only the contracts agent-filter engine may implement agent filtering.
 *
 * ADR-0085: `applyAgentFilters` in `packages/contracts/src/agent-filters.ts` is
 * the single filter engine. Session replay and live runs must not duplicate the
 * errors-only / top:N severity-filter idiom.
 */
import { defineCheck, isTestFile, type CheckViolation } from '@opensip-cli/fitness';

const ENGINE_PATH = 'packages/contracts/src/agent-filters.ts';

function looksLikeDuplicateAgentFilter(line: string): boolean {
  return (
    line.includes('errors-only') && (line.includes("=== 'high'") || line.includes('=== "high"'))
  );
}

export function analyzeSingleAgentFilterEngine(
  content: string,
  filePath: string,
): CheckViolation[] {
  const normalized = filePath.replaceAll('\\', '/');
  if (normalized.includes(ENGINE_PATH)) return [];
  if (isTestFile(filePath)) return [];
  if (normalized.includes('agent-filters.test')) return [];

  const violations: CheckViolation[] = [];
  const lines = content.split('\n');
  for (const [i, line_] of lines.entries()) {
    const line = line_;
    if (looksLikeDuplicateAgentFilter(line)) {
      violations.push({
        message:
          'Agent filter logic must use applyAgentFilters from @opensip-cli/contracts — do not duplicate (ADR-0085)',
        line: i + 1,
        column: 1,
        severity: 'error',
        suggestion: `Import applyAgentFilters from '@opensip-cli/contracts' instead of reimplementing in ${normalized}`,
      });
    }
  }
  return violations;
}

export const singleAgentFilterEngineCheck = defineCheck({
  id: 'b2c3d4e5-f6a7-8901-bcde-f12345678901',
  slug: 'single-agent-filter-engine',
  description: 'Only the contracts agent-filter engine may implement agent filtering (ADR-0085)',
  scope: { languages: ['typescript'], concerns: ['backend', 'server'] },
  tags: ['architecture'],
  analyze: (content, filePath) => analyzeSingleAgentFilterEngine(content, filePath),
});
