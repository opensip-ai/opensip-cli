/**
 * @fileoverview Navigation Typing Check
 *
 * Verifies that navigation params are properly typed for type-safe routing.
 */

import { defineCheck, type CheckViolation } from '@opensip-cli/fitness';

/**
 * Analyzes a single file for navigation typing issues
 */
function analyzeFile(content: string, filePath: string): CheckViolation[] {
  const violations: CheckViolation[] = [];

  // Quick filter: skip files without navigation patterns
  if (!content.includes('useLocalSearchParams') && !content.includes('router.push')) {
    return violations;
  }

  // Check for untyped useLocalSearchParams
  const untypedParamsRegex = /useLocalSearchParams\s*\(\s*\)/g;
  let match;
  while ((match = untypedParamsRegex.exec(content)) !== null) {
    const line = content.slice(0, Math.max(0, match.index)).split('\n').length;
    violations.push({
      filePath,
      line,
      column: 0,
      message: 'useLocalSearchParams without type parameter',
      severity: 'warning',
      type: 'untyped-params',
      suggestion:
        'Add type parameter: useLocalSearchParams<{ id: string }>() to get type-safe route params.',
      match: 'useLocalSearchParams()',
    });
  }

  // Check for untyped router.push with params
  const untypedPushRegex = /router\.push\(\s*['"`][^'"`]+['"`]\s*,\s*\{/g;
  while ((match = untypedPushRegex.exec(content)) !== null) {
    const line = content.slice(0, Math.max(0, match.index)).split('\n').length;
    violations.push({
      filePath,
      line,
      column: 0,
      message: 'router.push with inline params may lack type safety',
      severity: 'warning',
      type: 'untyped-push',
      suggestion: 'Use typed route helpers or define route types for type-safe navigation params.',
      match: 'router.push',
    });
  }

  return violations;
}

/**
 * Check: quality/navigation-typing
 *
 * Verifies navigation params are properly typed for type-safe routing.
 */
export const navigationTyping = defineCheck({
  id: '11547dc2-7666-4617-9705-be27528c4227',
  slug: 'navigation-typing',
  disabled: true,
  scope: { languages: ['typescript', 'tsx'], concerns: ['frontend', 'ui'] },
  contentFilter: 'strip-strings',

  confidence: 'medium',
  description: 'Verify navigation params are properly typed for type-safe routing',
  longDescription: `**Purpose:** Ensures Expo Router navigation parameters are properly typed for compile-time type safety on route params.

**Detects:** Analyzes each file individually using regex-based pattern matching.
- \`useLocalSearchParams()\` called without a type parameter (matches \`/useLocalSearchParams\\s*\\(\\s*\\)/\`)
- \`router.push()\` called with a string route and inline object params (matches \`/router\\.push\\(\\s*['"\`][^'"\`]+['"\`]\\s*,\\s*\\{/\`)
- Uses a quick-filter optimization: skips files not containing \`useLocalSearchParams\` or \`router.push\`

**Why it matters:** Untyped navigation params silently accept wrong types at compile time, leading to runtime crashes when route params are missing or have unexpected shapes.

**Scope:** General best practice`,
  tags: ['quality', 'type-safety', 'best-practices', 'react-native'],
  fileTypes: ['ts', 'tsx'],

  analyze: analyzeFile,
});
