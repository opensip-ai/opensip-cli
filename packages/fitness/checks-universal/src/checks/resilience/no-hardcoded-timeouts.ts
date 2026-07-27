/**
 * @fileoverview No hardcoded timeouts check
 */

import { logger } from '@opensip-cli/core';
import { defineCheck, isTestFile, type CheckViolation, getLineNumber } from '@opensip-cli/fitness';
import {
  stripStringLiterals,
  stripStringsAndComments,
  stripStringsAndCommentsPreservingPositions,
} from '@opensip-cli/fitness';

import { isDigit, isAlphanumericChar } from './_helpers/config-validation.js';

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Minimum timeout to flag (5000ms = 5 seconds)
 */
// @fitness-ignore-next-line no-hardcoded-timeouts -- constant defined at module scope for check threshold configuration
const MIN_FLAGGABLE_TIMEOUT = 5000;

// =============================================================================
// TIMEOUT EXTRACTION
// =============================================================================

/**
 * Walk forward from an opening `(` at `openIndex` and return the index of
 * its balanced closing `)`, or -1 if the parens never balance.
 */
function findMatchingParen(str: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < str.length; i++) {
    if (str[i] === '(') depth++;
    else if (str[i] === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Split `argsText` (the text between a call's balanced parens) into its
 * top-level, comma-separated arguments — commas nested inside `()`/`{}`/`[]`
 * (e.g. inside the callback body) do not split.
 */
function splitTopLevelArgs(argsText: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < argsText.length; i++) {
    const ch = argsText[i];
    if (ch === '(' || ch === '{' || ch === '[') depth++;
    else if (ch === ')' || ch === '}' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) {
      args.push(argsText.slice(start, i));
      start = i + 1;
    }
  }
  args.push(argsText.slice(start));
  return args;
}

/**
 * Parse `setTimeout`'s delay argument — the second top-level argument, e.g.
 * the `10000` in `"() => {\n  doWork();\n}, 10000"`. `setTimeout(cb, delay,
 * ...args)` forwards any further arguments to the callback, so the delay is
 * NOT necessarily the call's last argument — it is always the second one.
 * Returns null when that argument isn't a bare digit run (a variable
 * reference, another call, etc.), matching the "hardcoded literal only"
 * scope of the other extractors.
 */
function parseTrailingTimeoutArg(argsText: string): { timeout: number; digitCount: number } | null {
  const args = splitTopLevelArgs(argsText);
  if (args.length < 2) return null;
  const delayArg = (args[1] ?? '').trim();
  if (delayArg.length === 0) return null;
  for (const ch of delayArg) {
    if (!isDigit(ch)) return null;
  }
  // @fitness-ignore-next-line numeric-validation -- substring is guaranteed digit-only by the loop above
  return { timeout: Number.parseInt(delayArg, 10), digitCount: delayArg.length };
}

/* v8 ignore start -- timeout extraction state machines; many parser-state branches covered indirectly */
/**
 * Find every `setTimeout(...)` call in `content` and extract its trailing
 * numeric delay argument via a balanced-parenthesis walk from the call's
 * opening paren to its matching close. This spans newlines — unlike the
 * previous line-by-line extraction (which scanned one `line` at a time
 * and so returned null the instant a callback body continued onto a
 * following line, making the idiomatic block-body form
 * (`setTimeout(() => {\n  ...\n}, 10000)`) invisible — this walk finds
 * the delay regardless of how many lines the callback spans, then reads
 * the final numeric argument before the balanced close.
 *
 * Runs against `stripStringsAndCommentsPreservingPositions(content)`, a
 * same-length/same-line-structure view with strings and comments blanked,
 * so a commented-out or string-embedded `setTimeout(` never matches and
 * `getLineNumber(content, index)` still maps back to the true line.
 */
function findSetTimeoutOccurrences(
  content: string,
): { index: number; timeout: number; matchText: string }[] {
  logger.debug({
    evt: 'fitness.checks.no_hardcoded_timeouts.find_set_timeout_occurrences',
    msg: 'Scanning file for setTimeout(...) calls',
  });
  const stripped = stripStringsAndCommentsPreservingPositions(content);
  const results: { index: number; timeout: number; matchText: string }[] = [];
  const headerPattern = /setTimeout\s*\(/g;
  let headerMatch: RegExpExecArray | null;
  while ((headerMatch = headerPattern.exec(stripped)) !== null) {
    const openParenIndex = headerMatch.index + headerMatch[0].length - 1;
    const closeParenIndex = findMatchingParen(stripped, openParenIndex);
    if (closeParenIndex === -1) continue;

    const argsText = stripped.slice(openParenIndex + 1, closeParenIndex);
    const parsed = parseTrailingTimeoutArg(argsText);
    if (!parsed || parsed.digitCount < 4) continue;

    results.push({
      index: headerMatch.index,
      timeout: parsed.timeout,
      matchText: `setTimeout(..., ${parsed.timeout})`,
    });
  }
  return results;
}

/**
 * Extract timeout assignment value using string parsing.
 */
function extractTimeoutAssignment(line: string): { timeout: number; matchText: string } | null {
  logger.debug({
    evt: 'fitness.checks.no_hardcoded_timeouts.extract_timeout_assignment',
    msg: 'Extracting timeout assignment value from line',
  });
  const lowerLine = line.toLowerCase();
  const idx = lowerLine.indexOf('timeout');
  if (idx === -1) return null;

  // Skip if this is setTimeout (handled separately)
  if (idx >= 3 && lowerLine.slice(idx - 3, idx) === 'set') return null;

  const afterTimeout = line.slice(Math.max(0, idx + 7));
  let i = 0;

  // Skip whitespace
  while (i < afterTimeout.length && (afterTimeout[i] === ' ' || afterTimeout[i] === '\t')) {
    i++;
  }

  // Check for = or :
  if (afterTimeout[i] !== '=' && afterTimeout[i] !== ':') {
    return null;
  }
  i++;

  // Skip whitespace
  while (i < afterTimeout.length && (afterTimeout[i] === ' ' || afterTimeout[i] === '\t')) {
    i++;
  }

  // Parse the timeout number (4+ digits)
  const digitStart = i;
  while (i < afterTimeout.length && isDigit(afterTimeout[i])) {
    i++;
  }

  const digitCount = i - digitStart;
  if (digitCount < 4) return null;

  // Word boundary check
  if (i < afterTimeout.length && isAlphanumericChar(afterTimeout[i])) {
    return null;
  }

  // @fitness-ignore-next-line numeric-validation -- substring is guaranteed digit-only by isDigit loop above
  const timeout = Number.parseInt(afterTimeout.slice(digitStart, i), 10);
  return {
    timeout,
    matchText: `timeout${afterTimeout.slice(0, Math.max(0, i))}`,
  };
}

/**
 * Extract .timeout(N) value using string parsing.
 */
function extractDotTimeout(line: string): { timeout: number; matchText: string } | null {
  logger.debug({
    evt: 'fitness.checks.no_hardcoded_timeouts.extract_dot_timeout',
    msg: 'Extracting .timeout() value from line',
  });
  const idx = line.indexOf('.timeout');
  if (idx === -1) return null;

  const afterDotTimeout = line.slice(Math.max(0, idx + 8));
  let i = 0;

  // Skip whitespace
  while (
    i < afterDotTimeout.length &&
    (afterDotTimeout[i] === ' ' || afterDotTimeout[i] === '\t')
  ) {
    i++;
  }

  // Expect (
  if (afterDotTimeout[i] !== '(') return null;
  i++;

  // Skip whitespace
  while (
    i < afterDotTimeout.length &&
    (afterDotTimeout[i] === ' ' || afterDotTimeout[i] === '\t')
  ) {
    i++;
  }

  // Parse the timeout number (4+ digits)
  const digitStart = i;
  while (i < afterDotTimeout.length && isDigit(afterDotTimeout[i])) {
    i++;
  }

  const digitCount = i - digitStart;
  if (digitCount < 4) return null;

  // @fitness-ignore-next-line numeric-validation -- substring is guaranteed digit-only by isDigit loop above
  const timeout = Number.parseInt(afterDotTimeout.slice(digitStart, i), 10);

  // Skip whitespace and expect )
  while (
    i < afterDotTimeout.length &&
    (afterDotTimeout[i] === ' ' || afterDotTimeout[i] === '\t')
  ) {
    i++;
  }
  if (afterDotTimeout[i] !== ')') return null;
  i++;

  return {
    timeout,
    matchText: `.timeout${afterDotTimeout.slice(0, Math.max(0, i))}`,
  };
}
/* v8 ignore stop */

/**
 * Extract timeout value from a line using string parsing.
 *
 * `setTimeout(...)` is intentionally NOT handled here — it is scanned once
 * across the whole file by {@link findSetTimeoutOccurrences} so a callback
 * body spanning multiple lines is still found. Handling it per-line here
 * too would double-report the single-line case.
 */
function extractTimeoutFromLine(line: string): { timeout: number; matchText: string } | null {
  logger.debug({
    evt: 'fitness.checks.no_hardcoded_timeouts.extract_timeout_from_line',
    msg: 'Extracting timeout value from line',
  });
  // Check for timeout = NUMBER or timeout: NUMBER
  const timeoutAssignMatch = extractTimeoutAssignment(line);
  if (timeoutAssignMatch) return timeoutAssignMatch;

  // Check for .timeout(NUMBER)
  const dotTimeoutMatch = extractDotTimeout(line);
  if (dotTimeoutMatch) return dotTimeoutMatch;

  return null;
}

// =============================================================================
// LINE CHECKING
// =============================================================================

/**
 * Check if a line should be skipped for timeout checking.
 */
function shouldSkipTimeoutLine(line: string | undefined): boolean {
  logger.debug({
    evt: 'fitness.checks.no_hardcoded_timeouts.should_skip_timeout_line',
    msg: 'Checking if line should be skipped for timeout checking',
  });
  /* v8 ignore next -- defensive: lines.entries() never yields undefined */
  if (!line) return true;
  const trimmed = line.trim();
  return trimmed.startsWith('//') || trimmed.startsWith('*');
}

// =============================================================================
// CHECK DEFINITION
// =============================================================================

/**
 * Check: resilience/no-hardcoded-timeouts
 *
 * Detects hardcoded timeout values that should be configurable.
 */
export const noHardcodedTimeouts = defineCheck({
  id: '5c183a31-ff6e-4120-a7a5-39a32dbbcfa5',
  slug: 'no-hardcoded-timeouts',
  scope: { languages: ['typescript'], concerns: ['backend', 'server'] },
  contentFilter: 'strip-strings',

  confidence: 'medium',
  description: 'Detect hardcoded timeout values that should be configurable',
  longDescription: `**Purpose:** Flags hardcoded timeout values that should be externalized to configuration for environment-specific tuning.

**Detects:**
- \`setTimeout(callback, N)\` where N has 4+ digits (>= 1000ms) and the value >= 5000ms
- \`timeout = N\` or \`timeout: N\` assignments where N has 4+ digits and >= 5000ms
- \`.timeout(N)\` method calls where N has 4+ digits and >= 5000ms
- Skips comment lines and lines starting with \`//\` or \`*\`

**Why it matters:** Hardcoded timeouts cannot be tuned per environment; a value suitable for development may cause failures or excessive waits in production.

**Scope:** General best practice. Analyzes each file individually via string parsing.`,
  tags: ['resilience', 'config', 'timeout'],
  fileTypes: ['ts'],

  analyze(content: string, filePath: string): CheckViolation[] {
    // Skip test files — hardcoded timeouts in tests are low-risk
    if (isTestFile(filePath)) return [];

    logger.debug({
      evt: 'fitness.checks.no_hardcoded_timeouts.analyze',
      msg: 'Analyzing file for hardcoded timeout values',
    });
    const violations: CheckViolation[] = [];

    // Skip files that don't have timeout patterns (strip strings/comments to avoid false positives)
    const strippedContent = stripStringsAndComments(content);
    if (!strippedContent.includes('timeout') && !strippedContent.includes('setTimeout')) {
      return violations;
    }

    // setTimeout(...) is scanned across the whole file (not line-by-line)
    // so a block-body callback spanning multiple lines is still found.
    for (const occurrence of findSetTimeoutOccurrences(content)) {
      if (occurrence.timeout < MIN_FLAGGABLE_TIMEOUT) continue;
      violations.push({
        line: getLineNumber(content, occurrence.index),
        column: 0,
        message: `Hardcoded timeout value: ${occurrence.timeout}ms`,
        severity: 'warning',
        suggestion:
          'Use configurable timeout from configuration or constants. Example: const timeout = config.get("httpTimeout") or import { HTTP_TIMEOUT } from "./constants"',
        match: occurrence.matchText,
        type: 'hardcoded-timeout',
        filePath,
      });
    }

    const lines = content.split('\n');
    for (const [i, line] of lines.entries()) {
      if (!line || shouldSkipTimeoutLine(line)) {
        continue;
      }

      const strippedLine = stripStringLiterals(line);
      const result = extractTimeoutFromLine(strippedLine);
      if (!result || result.timeout < MIN_FLAGGABLE_TIMEOUT) continue;

      const lineNumber = i + 1;
      violations.push({
        line: lineNumber,
        column: 0,
        message: `Hardcoded timeout value: ${result.timeout}ms`,
        severity: 'warning',
        suggestion:
          'Use configurable timeout from configuration or constants. Example: const timeout = config.get("httpTimeout") or import { HTTP_TIMEOUT } from "./constants"',
        match: result.matchText,
        type: 'hardcoded-timeout',
        filePath,
      });
    }

    return violations;
  },
});
