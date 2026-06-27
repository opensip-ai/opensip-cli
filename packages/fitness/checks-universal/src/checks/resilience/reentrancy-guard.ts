// @fitness-ignore-file fitness-check-coverage -- check implementation with framework-managed coverage
/**
 * @fileoverview Detects boolean flag reentrancy guards that should use counters or mutexes
 */

import { defineCheck, type CheckViolation, getLineNumber } from '@opensip-cli/fitness';

/**
 * Pattern for detecting module-scoped boolean state flags used as reentrancy guards.
 * Matches: let serverRunning = false, let isRunning = false, etc.
 */
const BOOLEAN_FLAG_PATTERN =
  /^(?:let|var)\s+(\w+(?:Running|Started|Active|Initialized|Locked))\s*(?::\s*boolean\s*)?=\s*false/gm;

/**
 * Pattern for early return based on the flag (reentrancy guard)
 */
function createFlagCheckPattern(flagName: string): RegExp {
  // @fitness-ignore-next-line semgrep-scan -- non-literal RegExp is intentional; flagName is extracted from regex match on source code identifiers (\w+), not user input
  return new RegExp(String.raw`if\s*\(\s*${flagName}\s*\)\s*(?:return|\{)`);
}

/**
 * Check: resilience/reentrancy-guard
 *
 * Detects module-scoped boolean flags used as reentrancy guards
 * (e.g., `let serverRunning = false` with `if (serverRunning) return`).
 * These are not re-entrant and can corrupt state with concurrent calls.
 */
export const reentrancyGuard = defineCheck({
  id: 'd7f35c3b-af42-435f-b953-ee167060fecb',
  slug: 'reentrancy-guard',
  scope: {
    languages: ['typescript'],
    concerns: ['backend', 'frontend', 'cli'],
  },
  contentFilter: 'strip-strings',

  confidence: 'medium',
  description: 'Detect boolean reentrancy guards that need counter/mutex semantics',
  longDescription: `**Purpose:** Detects module-scoped boolean flags used as reentrancy guards that can fail under concurrent or nested calls.

**Detects:**
- Module-scoped \`let\` boolean variables with names like \`*Running\`, \`*Started\`, \`*Active\`, \`*Initialized\`, \`*Locked\` initialized to \`false\`
- Paired with an \`if (flag) return\` guard pattern indicating reentrancy protection
- These boolean guards are not re-entrant: nested calls will see the flag as \`true\` and silently skip, and concurrent calls can interleave flag reads/writes

**Why it matters:** Boolean flags for reentrancy create race conditions where concurrent callers skip initialization or corrupt shared state. A reference counter or mutex provides correct semantics.

**Scope:** General best practice. Analyzes each file individually via regex.`,
  tags: ['resilience', 'concurrency', 'reentrancy'],
  fileTypes: ['ts'],

  analyze(content: string, filePath: string): CheckViolation[] {
    const violations: CheckViolation[] = [];

    // Skip test files
    if (
      filePath.includes('.test.') ||
      filePath.includes('.spec.') ||
      filePath.includes('__tests__')
    ) {
      return violations;
    }

    // Quick check
    if (
      !content.includes('Running') &&
      !content.includes('Started') &&
      !content.includes('Active') &&
      !content.includes('Initialized') &&
      !content.includes('Locked')
    ) {
      return violations;
    }

    BOOLEAN_FLAG_PATTERN.lastIndex = 0;
    let match;
    while ((match = BOOLEAN_FLAG_PATTERN.exec(content)) !== null) {
      const flagName = match[1];
      if (!flagName) continue;

      // Check if there's a corresponding guard pattern
      const guardPattern = createFlagCheckPattern(flagName);
      if (!guardPattern.test(content)) continue;

      const lineNumber = getLineNumber(content, match.index);

      violations.push({
        line: lineNumber,
        column: 0,
        message: `Boolean reentrancy guard '${flagName}' is not safe for concurrent or nested calls`,
        severity: 'warning',
        suggestion:
          'Replace the boolean flag with a reference counter (increment on enter, decrement on exit) or use a mutex/semaphore for proper reentrancy protection.',
        match: match[0],
        type: 'boolean-reentrancy-guard',
        filePath,
      });
    }

    return violations;
  },
});
