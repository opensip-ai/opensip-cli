// @fitness-ignore-file project-readme-existence -- internal module, not a package root
// @fitness-ignore-file fitness-check-coverage -- check implementation with framework-managed coverage
/**
 * @fileoverview Detects process.exit() usage that bypasses finally blocks
 */

import { defineCheck, type CheckViolation, getLineNumber } from '@opensip-cli/fitness';

/**
 * Pattern for detecting process.exit() calls
 */
const PROCESS_EXIT_PATTERN = /process\.exit\s*\(/g;

/**
 * Pattern for detecting an actual try/finally clause: a closing brace
 * (of the try or catch block) immediately followed by `finally {`.
 *
 * Critical: must NOT match `Promise.finally(...)` (a method call),
 * which is `.finally(` — preceded by a dot, followed by `(`. The
 * `}\s*finally\s*\{` shape excludes both cases by requiring brace
 * adjacency on both sides.
 */
const TRY_FINALLY_PATTERN = /\}\s*finally\s*\{/;

/**
 * Check: resilience/no-process-exit-in-finally
 *
 * Detects process.exit() calls in files that contain try/finally blocks,
 * which would bypass cleanup logic in the finally block.
 */
export const noProcessExitInFinally = defineCheck({
  id: '58c0aaf6-f965-4336-983f-ee1033269e54',
  slug: 'no-process-exit-in-finally',
  scope: { languages: ['typescript'], concerns: ['backend', 'frontend', 'cli'] },
  contentFilter: 'strip-strings',

  confidence: 'medium',
  description: 'Detect process.exit() that bypasses finally cleanup',
  longDescription: `**Purpose:** Prevents \`process.exit()\` from bypassing \`finally\` block cleanup logic, which can leave resources (servers, file handles, database connections) in an inconsistent state.

**Detects:**
- \`process.exit()\` calls in files that also contain \`try/finally\` blocks
- Skips test files and comment lines

**Why it matters:** \`process.exit()\` terminates the process immediately, skipping all pending \`finally\` blocks. This can cause server cleanup bypass, leaked file handles, and corrupted state.

**Scope:** General best practice. Analyzes each file individually via regex.`,
  tags: ['resilience', 'cleanup', 'process'],
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

    // Quick check: must have both process.exit and finally
    if (!content.includes('process.exit') || !content.includes('finally')) {
      return violations;
    }

    // Verify the file has a real try/finally clause (not Promise.finally).
    // The pattern `}\s*finally\s*\{` requires brace adjacency on both sides,
    // which method-style `.finally(...)` cannot match.
    if (!TRY_FINALLY_PATTERN.test(content)) {
      return violations;
    }

    // Find all process.exit() calls
    PROCESS_EXIT_PATTERN.lastIndex = 0;
    const lines = content.split('\n');
    let match;
    while ((match = PROCESS_EXIT_PATTERN.exec(content)) !== null) {
      const lineNumber = getLineNumber(content, match.index);
      const line = lines[lineNumber - 1] ?? '';
      const trimmed = line.trim();

      // Skip comment lines
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) {
        continue;
      }

      violations.push({
        line: lineNumber,
        column: 0,
        message: 'process.exit() in file with try/finally blocks — cleanup will be bypassed',
        severity: 'error',
        suggestion:
          'Throw a typed error instead of calling process.exit(). Let the top-level error handler decide the exit code. This ensures finally blocks execute for proper resource cleanup.',
        match: match[0],
        type: 'process-exit-bypasses-finally',
        filePath,
      });
    }

    return violations;
  },
});
