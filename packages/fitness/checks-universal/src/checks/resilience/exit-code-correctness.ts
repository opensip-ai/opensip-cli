// @fitness-ignore-file fitness-check-coverage -- check implementation with framework-managed coverage
/**
 * @fileoverview Detects error branches that silently exit with success (exit 0)
 */

import {
  defineCheck,
  isCommentLine,
  type CheckViolation,
  getLineNumber,
} from '@opensip-cli/fitness';

/**
 * Header of a `catch (...) {` block, up to and including its opening brace.
 * The body is NOT captured here — a fixed-depth regex like the previous
 * `CATCH_BLOCK_PATTERN` (`[^{}]*(?:\{[^{}]*\}[^{}]*)*`) only balances ONE
 * level of nested braces, so it produces zero matches for any catch body
 * containing a doubly nested block — e.g. `if (...) { for (...) { ... } }`,
 * the common shape of real-world retry/cleanup logic. `findCatchBlocks`
 * below walks forward from this header's opening brace with a simple
 * depth counter instead, which balances to arbitrary nesting depth.
 */
const CATCH_HEADER_PATTERN = /\bcatch\s*\([^)]*\)\s*\{/g;

/** One `catch (...) { ... }` block discovered by {@link findCatchBlocks}. */
interface CatchBlock {
  /** Index of the `catch` keyword — used for line-number reporting. */
  readonly index: number;
  /** Body text between the balanced braces (exclusive of both braces). */
  readonly body: string;
}

/**
 * Walk forward from an opening `{` at `openIndex` and return the index of
 * its balanced closing `}`, or -1 if the braces never balance (malformed
 * or truncated input — the caller skips rather than mis-reports).
 */
function findMatchingBrace(content: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < content.length; i++) {
    if (content[i] === '{') depth++;
    else if (content[i] === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Find every `catch (...) { ... }` block in `content`, resolving each
 * body via balanced brace counting (not a fixed-depth regex) so bodies
 * with 2+ levels of nested braces are found. `content` has already been
 * through the check's `contentFilter: 'strip-strings'`, so braces inside
 * string literals cannot perturb the depth count.
 */
function findCatchBlocks(content: string): CatchBlock[] {
  const blocks: CatchBlock[] = [];
  CATCH_HEADER_PATTERN.lastIndex = 0;
  let headerMatch: RegExpExecArray | null;
  while ((headerMatch = CATCH_HEADER_PATTERN.exec(content)) !== null) {
    const openBraceIndex = headerMatch.index + headerMatch[0].length - 1;
    const closeBraceIndex = findMatchingBrace(content, openBraceIndex);
    if (closeBraceIndex === -1) continue;
    blocks.push({
      index: headerMatch.index,
      body: content.slice(openBraceIndex + 1, closeBraceIndex),
    });
  }
  return blocks;
}

/** Patterns indicating error is logged */
const ERROR_LOG_PATTERNS = [/logger\.error/, /logger\.fatal/, /console\.error/];

/** Patterns indicating error is propagated or recorded for the caller */
const ERROR_PROPAGATION_PATTERNS = [
  /\bthrow\b/,
  /process\.exit\s*\(\s*1\s*\)/,
  /process\.exitCode\s*=\s*1/,
  /return\s+err\s*\(/,
  /return\s+Result\.err/,
  /return\s+\{\s*ok\s*:\s*false/,
  /return\s+undefined/, // Signal failure to caller via sentinel return
  /\.errors\.push\(/, // Error aggregation pattern — error is collected for batch reporting
  /\.push\(\s*`/, // Template literal push to errors array
  // CLI dispatcher pattern: tools set a non-success exit code on the
  // shared context instead of calling process.exit() directly. Two forms:
  // a named exit-code constant (…ERROR / …FAILURE / …FAIL) …
  /setExitCode\s*\([^)]*(?:ERROR|FAILURE|FAIL)\b/,
  // … or a numeric non-zero literal (`setExitCode(1)`, `cli.setExitCode(2)`).
  // A zero literal is intentionally NOT matched — that would mask the very
  // "log error then exit 0" pattern this check exists to catch.
  /setExitCode\s*\(\s*[1-9]/,
];

/**
 * Check: resilience/exit-code-correctness
 *
 * Detects catch blocks that log errors but silently allow execution to continue
 * (masking failures), especially in CLI command handlers where this means
 * exiting with code 0 despite a failure.
 */
export const exitCodeCorrectness = defineCheck({
  id: 'c5007f87-9c72-49be-861a-a419cac1006f',
  slug: 'exit-code-correctness',
  scope: {
    languages: ['typescript'],
    concerns: ['backend', 'frontend', 'cli'],
  },
  contentFilter: 'strip-strings',

  confidence: 'medium',
  description: 'Detect error branches that mask failures with silent success exit',
  longDescription: `**Purpose:** Prevents error branches from silently masking failures by logging the error but allowing execution to continue with an implicit success exit code.

**Detects:**
- \`catch\` blocks in CLI command files that log errors (\`logger.error\`, \`console.error\`) but do not propagate the failure (via \`throw\`, \`process.exit(1)\`, or \`Result.err\`)
- This pattern causes CLI commands to exit 0 despite encountering errors, making failures invisible to scripts and CI pipelines

**Why it matters:** Silent failure masking means CI pipelines, scripts, and orchestrators cannot detect that an operation failed, leading to cascading silent corruption.

**Scope:** CLI and command handler files. Analyzes each file individually via regex.`,
  tags: ['resilience', 'cli', 'error-handling'],
  fileTypes: ['ts'],

  analyze(content: string, filePath: string): CheckViolation[] {
    const violations: CheckViolation[] = [];
    const normalized = filePath.replaceAll('\\', '/');

    // Target CLI and command handler files (POSIX segment match on OS paths)
    if (
      !normalized.includes('/cli/') &&
      !normalized.includes('/commands/') &&
      !normalized.includes('/bin/')
    ) {
      return violations;
    }

    // Skip test files
    if (
      normalized.includes('.test.') ||
      normalized.includes('.spec.') ||
      normalized.includes('__tests__')
    ) {
      return violations;
    }

    // Quick check
    if (!content.includes('catch')) {
      return violations;
    }

    for (const block of findCatchBlocks(content)) {
      const catchBody = block.body;

      // Only flag if it logs an error
      const logsError = ERROR_LOG_PATTERNS.some((p) => p.test(catchBody));
      if (!logsError) continue;

      // Check if error is actually propagated
      const propagatesError = ERROR_PROPAGATION_PATTERNS.some((p) => p.test(catchBody));
      if (propagatesError) continue;

      const lineNumber = getLineNumber(content, block.index);
      const line = content.split('\n')[lineNumber - 1] ?? '';
      if (isCommentLine(line)) continue;

      violations.push({
        line: lineNumber,
        column: 0,
        message: 'Catch block logs error but does not propagate failure — process will exit 0',
        severity: 'warning',
        suggestion:
          'Re-throw the error, call process.exit(1), or return a Result.err() to ensure the failure is visible to callers and CI pipelines.',
        match: content.slice(block.index, block.index + 60),
        type: 'silent-failure-exit',
        filePath,
      });
    }

    return violations;
  },
});
