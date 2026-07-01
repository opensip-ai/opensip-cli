/**
 * @fileoverview single-agent-filter-engine — only the contracts agent-filter
 *               engine may implement agent filtering. Project-local SELF-check.
 *
 * Lives here (not in the shipped `@opensip-cli/checks-*` packs) because it
 * encodes opensip-cli local facts: it cites ADR-0085 and hardcodes the
 * first-party engine path (`packages/contracts/src/agent-filters.ts`) and the
 * `@opensip-cli/contracts` coupling. A consumer repo has none of those facts, so
 * the rule is opensip-internal, not universal — `shipped-checks-must-be-generic`
 * steers exactly this kind of pure-text dogfood check to a project-local .mjs.
 * Being project-local also keeps the check from scanning its OWN source (the
 * detection pattern appears as a string literal here), which a shipped placement
 * under `packages/**` could not avoid.
 *
 * WHY: `applyAgentFilters` in `packages/contracts/src/agent-filters.ts` is the
 * single filter engine (ADR-0085). Session replay and live runs must not
 * duplicate the errors-only / top:N severity-filter idiom.
 */
import { defineCheck, isTestFile } from '@opensip-cli/fitness';

const ENGINE_PATH = 'packages/contracts/src/agent-filters.ts';

function looksLikeDuplicateAgentFilter(line) {
  return (
    line.includes('errors-only') && (line.includes("=== 'high'") || line.includes('=== "high"'))
  );
}

export function analyzeSingleAgentFilterEngine(content, filePath) {
  const normalized = filePath.replaceAll('\\', '/');
  if (normalized.includes(ENGINE_PATH)) return [];
  if (isTestFile(filePath)) return [];
  if (normalized.includes('agent-filters.test')) return [];

  const violations = [];
  const lines = content.split('\n');
  for (const [i, line] of lines.entries()) {
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

export const checks = [
  defineCheck({
    id: '8b9a143c-9b5c-4f2d-9b8c-8feea69001b0',
    slug: 'single-agent-filter-engine',
    description: 'Only the contracts agent-filter engine may implement agent filtering (ADR-0085)',
    scope: { languages: ['typescript'], concerns: ['backend', 'server'] },
    tags: ['architecture'],
    fileTypes: ['ts', 'tsx'],
    contentFilter: 'raw',
    analyze: (content, filePath) => analyzeSingleAgentFilterEngine(content, filePath),
  }),
];
