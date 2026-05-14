/**
 * @fileoverview Async State Pattern Check
 *
 * Enforces that data-driven screens are wrapped in the AsyncState pattern.
 * Screens using TanStack Query should use AsyncState for consistent loading/error handling.
 */
// @fitness-ignore-next-line no-markdown-references -- rule provenance reference for developer context
// Rule source: .augment/rules/ui-patterns.md

import { defineCheck, type CheckViolation, extractSnippet } from '@opensip-tools/core'

/**
 * Paths to exclude from checking
 */
const NON_SCREEN_PATTERNS = [
  /node_modules/,
  /__tests__/,
  /\.test\./,
  /\.spec\./,
  /components\/patterns\//, // The pattern components themselves
]

/**
 * Check: quality/async-state-pattern
 *
 * Ensures data-driven screens use AsyncState pattern for consistent
 * loading and error state handling with TanStack Query.
 */
export const asyncStatePattern = defineCheck({
  id: '3bc0cb23-7354-4f85-b39f-d21813e6394c',
  slug: 'async-state-pattern',
  disabled: true,
  scope: { languages: ['typescript'], concerns: ['backend', 'server'] },
  contentFilter: 'strip-strings',

  confidence: 'medium',
  description: 'Ensure data-driven screens use AsyncState pattern',
  longDescription: `**Purpose:** Enforces that data-driven screens wrap TanStack Query results in the AsyncState component for consistent loading/error handling.

**Detects:** Analyzes each file individually. Screen files in \`/screens/\` that import \`useQuery\`, \`useMutation\`, or \`useInfiniteQuery\` but do not reference \`AsyncState\` or \`<AsyncState\`.

**Why it matters:** Without AsyncState, each screen implements its own loading/error UI, leading to inconsistent user experience and duplicated boilerplate.

**Scope:** Codebase-specific convention (rule source: .augment/rules/ui-patterns.md)`,
  tags: ['quality', 'frontend', 'patterns', 'tanstack-query', 'consistency'],
  fileTypes: ['ts', 'tsx'],

  analyze(content, filePath) {
    // Only check screen files
    if (
      !filePath.includes('/screens/') ||
      (!filePath.endsWith('.ts') && !filePath.endsWith('.tsx'))
    ) {
      return []
    }

    // Skip excluded paths
    if (NON_SCREEN_PATTERNS.some((pattern) => pattern.test(filePath))) {
      return []
    }

    const violations: CheckViolation[] = []

    // Check if file uses TanStack Query (useQuery, useMutation)
    const usesQuery = /use(Query|Mutation|InfiniteQuery)\s*\(/.test(content)
    if (!usesQuery) {
      return violations // Not a data-driven screen
    }

    // Check if file imports or uses AsyncState pattern
    const hasAsyncState = /AsyncState|<AsyncState/.test(content)
    if (!hasAsyncState) {
      // Find the useQuery line for better context
      const queryMatch = content.match(/use(Query|Mutation|InfiniteQuery)\s*\(/)
      const queryLine = queryMatch ? content.slice(0, queryMatch.index).split('\n').length : 1
      extractSnippet(content, queryLine, 3)
      const matchText = queryMatch?.[0] ?? 'useQuery'

      violations.push({
        line: queryLine,
        column: 0,
        message: 'Data-driven screen uses TanStack Query but not AsyncState pattern',
        severity: 'warning',
        suggestion:
          "Import AsyncState from 'components/patterns/' and wrap data display: <AsyncState isLoading={isLoading} error={error} data={data}>{...}</AsyncState>",
        type: 'missing-async-state',
        match: matchText,
      })
    }

    return violations
  },
})
