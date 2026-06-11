// @fitness-ignore-file project-readme-existence -- internal module, not a package root
// @fitness-ignore-file fitness-check-coverage -- check implementation with framework-managed coverage
/**
 * @fileoverview Detects readline usage without proper cleanup
 */

import { defineCheck, type CheckViolation, getLineNumber } from '@opensip-tools/fitness';

/**
 * Pattern for detecting readline.createInterface() calls
 */
const READLINE_CREATE_PATTERN = /readline\.createInterface\s*\(/g;

/**
 * Pattern for detecting readLine() helper calls (custom wrappers)
 */
const READLINE_HELPER_PATTERN = /\breadLine\s*\(/g;

/**
 * Patterns indicating proper cleanup
 */
const CLEANUP_PATTERNS = [
  /\.close\s*\(/,
  /finally/,
  /using\s/,
  /\[Symbol\.dispose\]/,
  /\[Symbol\.asyncDispose\]/,
];

/**
 * Check: resilience/readline-cleanup
 *
 * Detects readline interface creation without proper cleanup,
 * which can cause the process to hang if stdin doesn't close.
 */
export const readlineCleanup = defineCheck({
  id: 'd0e76036-c138-4132-99be-d2cddf9aeac1',
  slug: 'readline-cleanup',
  scope: { languages: ['typescript'], concerns: ['backend', 'frontend', 'cli'] },
  contentFilter: 'strip-strings',

  confidence: 'medium',
  description: 'Detect readline usage without proper cleanup (close/finally)',
  longDescription: `**Purpose:** Ensures readline interfaces are properly closed to prevent process hangs.

**Detects:**
- \`readline.createInterface()\` calls in files without corresponding \`.close()\` calls or \`finally\` blocks
- Custom \`readLine()\` helper calls without timeout or cleanup guards

**Why it matters:** An unclosed readline interface keeps the process alive waiting for stdin input, causing CLI commands to hang indefinitely instead of exiting cleanly.

**Scope:** General best practice. Analyzes each file individually via regex.`,
  tags: ['resilience', 'cleanup', 'readline'],
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
    if (!content.includes('readline') && !content.includes('readLine')) {
      return violations;
    }

    const hasCleanup = CLEANUP_PATTERNS.some((p) => p.test(content));

    // Check readline.createInterface without cleanup
    READLINE_CREATE_PATTERN.lastIndex = 0;
    let match;
    while ((match = READLINE_CREATE_PATTERN.exec(content)) !== null) {
      if (!hasCleanup) {
        const lineNumber = getLineNumber(content, match.index);
        violations.push({
          line: lineNumber,
          column: 0,
          message:
            'readline.createInterface() without .close() or finally block — process may hang',
          severity: 'warning',
          suggestion:
            'Wrap readline usage in a try/finally block and call rl.close() in the finally block, or use a timeout to prevent indefinite hangs.',
          match: match[0],
          type: 'readline-no-cleanup',
          filePath,
        });
      }
    }

    // Check readLine() helper without cleanup
    READLINE_HELPER_PATTERN.lastIndex = 0;
    while ((match = READLINE_HELPER_PATTERN.exec(content)) !== null) {
      // Skip if this is the definition of readLine, not a call
      const lineNumber = getLineNumber(content, match.index);
      const line = content.split('\n')[lineNumber - 1] ?? '';
      if (
        line.includes('function readLine') ||
        line.includes('const readLine') ||
        line.includes('async function readLine')
      ) {
        continue;
      }

      if (!hasCleanup) {
        violations.push({
          line: lineNumber,
          column: 0,
          message: 'readLine() call without cleanup guard — process may hang if stdin stalls',
          severity: 'warning',
          suggestion:
            'Ensure readLine() has a timeout mechanism or is wrapped in a try/finally with proper cleanup.',
          match: match[0],
          type: 'readline-helper-no-cleanup',
          filePath,
        });
      }
    }

    return violations;
  },
});
