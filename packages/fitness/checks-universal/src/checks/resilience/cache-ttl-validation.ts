// @fitness-ignore-file duplicate-implementation-detection -- reviewed: pattern is architecturally justified or false positive
// @fitness-ignore-file unused-config-options -- Config options reserved for future use or environment-specific
/**
 * @fileoverview Cache TTL validation check
 */

import { logger } from '@opensip-cli/core';
import { defineCheck, isTestFile, type CheckViolation } from '@opensip-cli/fitness';

import { isDigit } from './_helpers/config-validation.js';

// =============================================================================
// CONSTANTS
// =============================================================================

const MIN_TTL_SECONDS = 5; // Minimum 5 seconds to avoid thundering herd
const MAX_TTL_SECONDS = 86_400; // Maximum 24 hours for general data
const MAX_FINANCIAL_TTL_SECONDS = 60; // Maximum 1 minute for financial data

// =============================================================================
// DATA TYPE DETECTION
// =============================================================================

/**
 * Check if line contains financial data keywords.
 */
function isFinancialDataLine(line: string): boolean {
  const lowerLine = line.toLowerCase();
  const hasMoneyTerms =
    lowerLine.includes('balance') || lowerLine.includes('wallet') || lowerLine.includes('payment');
  const hasTransactionTerms =
    lowerLine.includes('transaction') ||
    lowerLine.includes('escrow') ||
    lowerLine.includes('price');
  const hasAccountingTerms =
    lowerLine.includes('amount') || lowerLine.includes('credit') || lowerLine.includes('debit');
  return hasMoneyTerms || hasTransactionTerms || hasAccountingTerms;
}

/**
 * Check if line contains sensitive data keywords.
 */
function isSensitiveDataLine(line: string): boolean {
  const lowerLine = line.toLowerCase();
  const hasSessionTerms = lowerLine.includes('session') || lowerLine.includes('token');
  const hasAuthTerms =
    lowerLine.includes('auth') || lowerLine.includes('permission') || lowerLine.includes('role');
  return hasSessionTerms || hasAuthTerms;
}

/**
 * Check if line should be skipped (non-cache pattern).
 */
function isNonCachePattern(line: string): boolean {
  const lowerLine = line.toLowerCase();
  const isMapOperation = line.includes('Map()') && line.includes('.set');
  const isCollectionInit = line.includes('new Map') || line.includes('new Set');
  const isMetricsOperation = lowerLine.includes('metrics.set') || lowerLine.includes('gauge.set');
  return isMapOperation || isCollectionInit || isMetricsOperation;
}

/**
 * Check if file contains cache-related patterns.
 */
function hasCachePatterns(content: string): boolean {
  const lowerContent = content.toLowerCase();
  return (
    lowerContent.includes('cache') || lowerContent.includes('redis') || lowerContent.includes('ttl')
  );
}

// =============================================================================
// TTL PARSING
// =============================================================================

/** One parsed `<name>Ttl: <number>` occurrence on a line. */
interface TtlCandidate {
  readonly ttl: number;
  readonly matchText: string;
  /**
   * The slice of the line that belongs to THIS occurrence — its own identifier
   * through to the start of the next `ttl` identifier (or end of line for the
   * last one). Financial/sensitive classification reads this, never the whole
   * line, so `{ userTtl: 300, balanceTtl: 3600 }` cannot report 300 as the
   * financial value.
   */
  readonly context: string;
}

/** Word characters that can form part of an identifier such as `balanceTtl`. */
function isIdentifierChar(ch: string | undefined): boolean {
  return ch !== undefined && /[\w$]/u.test(ch);
}

/** Walk left from `index` to the first character of the enclosing identifier. */
function identifierStart(line: string, index: number): number {
  let start = index;
  while (start > 0 && isIdentifierChar(line[start - 1])) {
    start--;
  }
  return start;
}

/** Index of every `ttl` substring on the line (case-insensitive). */
function ttlOccurrences(line: string): number[] {
  const lowerLine = line.toLowerCase();
  const indices: number[] = [];
  let from = 0;
  for (;;) {
    const idx = lowerLine.indexOf('ttl', from);
    if (idx === -1) return indices;
    indices.push(idx);
    from = idx + 3;
  }
}

/**
 * Parse the numeric value attached to the `ttl` substring at `ttlIndex`, or
 * null when that occurrence is not a `ttl = N` / `ttl: N` assignment.
 */
function parseTtlAt(line: string, ttlIndex: number): { ttl: number; matchText: string } | null {
  const afterTtl = line.slice(Math.max(0, ttlIndex + 3));
  let i = 0;

  // Skip whitespace
  while (i < afterTtl.length && (afterTtl[i] === ' ' || afterTtl[i] === '\t')) {
    i++;
  }

  // Check for = or :
  if (afterTtl[i] !== '=' && afterTtl[i] !== ':') {
    return null;
  }
  i++;

  // Skip whitespace
  while (i < afterTtl.length && (afterTtl[i] === ' ' || afterTtl[i] === '\t')) {
    i++;
  }

  // Parse digits
  const digitStart = i;
  while (i < afterTtl.length && isDigit(afterTtl[i])) {
    i++;
  }

  if (digitStart === i) {
    return null; // No digits found
  }

  // @fitness-ignore-next-line numeric-validation -- substring is guaranteed digit-only by isDigit loop above
  const ttlValue = Number.parseInt(afterTtl.slice(digitStart, i), 10);
  return {
    ttl: ttlValue,
    matchText: `ttl${afterTtl.slice(0, Math.max(0, i))}`,
  };
}

/**
 * Parse EVERY TTL assignment on a line.
 *
 * Scanning only the first `ttl` substring produced two wrong results on lines
 * carrying more than one: a leading non-numeric key (`defaultTtl: DEFAULT`)
 * abandoned the whole line and hid a real `sessionTtl: 1`, and the whole-line
 * financial/sensitive classification was applied to whichever value happened to
 * be parsed first.
 */
function parseTtlsFromLine(line: string): TtlCandidate[] {
  logger.debug({
    evt: 'fitness.checks.cache_ttl_validation.parse_ttl_from_line',
    msg: 'Parsing TTL values from line using string matching',
  });
  const occurrences = ttlOccurrences(line);
  const starts = occurrences.map((idx) => identifierStart(line, idx));
  const candidates: TtlCandidate[] = [];

  for (const [n, ttlIndex] of occurrences.entries()) {
    const parsed = parseTtlAt(line, ttlIndex);
    if (!parsed) continue;

    const contextStart = starts[n] ?? ttlIndex;
    // The last occurrence owns the rest of the line (so a trailing comment such
    // as `ttl: 600, // payment balance cache` still classifies). Earlier ones
    // stop where the next TTL identifier begins.
    const nextStart = starts[n + 1];
    const contextEnd = nextStart === undefined ? line.length : Math.max(nextStart, ttlIndex + 3);

    candidates.push({
      ...parsed,
      context: line.slice(contextStart, contextEnd),
    });
  }

  return candidates;
}

// =============================================================================
// VIOLATION DETECTION
// =============================================================================

interface TtlViolation {
  message: string;
  severity: 'error' | 'warning';
  suggestion: string;
  patternId: string;
}

/**
 * Detect TTL violation type based on value and data type.
 */
function detectTtlViolation(
  ttl: number,
  isFinancialData: boolean,
  isSensitiveData: boolean,
): TtlViolation | null {
  logger.debug({
    evt: 'fitness.checks.cache_ttl_validation.detect_ttl_violation',
    msg: 'Detecting TTL violation type based on value and data type',
  });
  // TTL too short
  if (ttl < MIN_TTL_SECONDS) {
    return {
      message: `TTL of ${ttl}s is too short, may cause thundering herd`,
      severity: 'warning',
      suggestion: `Increase TTL to at least ${MIN_TTL_SECONDS}s to prevent thundering herd when cache expires simultaneously for many requests.`,
      patternId: 'ttl-too-short',
    };
  }

  // Financial data with long TTL
  if (isFinancialData && ttl > MAX_FINANCIAL_TTL_SECONDS) {
    return {
      message: `Financial data cached with ${ttl}s TTL may cause stale data`,
      severity: 'error',
      suggestion: `Reduce TTL to ${MAX_FINANCIAL_TTL_SECONDS}s or less for financial data. Stale financial data can cause incorrect balances, payments, or escrow issues.`,
      patternId: 'financial-ttl-too-long',
    };
  }

  // Sensitive data with long TTL
  if (isSensitiveData && ttl > MAX_TTL_SECONDS / 4) {
    return {
      message: `Sensitive data cached with ${ttl}s TTL may cause auth issues`,
      severity: 'warning',
      suggestion: `Consider reducing TTL to ${MAX_TTL_SECONDS / 4}s or less for sensitive data like sessions, tokens, or permissions to prevent stale authorization state.`,
      patternId: 'sensitive-ttl-too-long',
    };
  }

  // General data with excessive TTL
  if (!isFinancialData && !isSensitiveData && ttl > MAX_TTL_SECONDS) {
    return {
      message: `TTL of ${ttl}s exceeds maximum recommended (${MAX_TTL_SECONDS}s)`,
      severity: 'warning',
      suggestion: `Reduce TTL to ${MAX_TTL_SECONDS}s (24 hours) or add a comment justifying the longer TTL for this specific use case.`,
      patternId: 'ttl-too-long',
    };
  }

  return null;
}

// =============================================================================
// CHECK DEFINITION
// =============================================================================

/**
 * Check: resilience/cache-ttl-validation
 *
 * Validates cache TTL values to prevent:
 * - Thundering herd (TTL too short)
 * - Stale data issues (TTL too long for sensitive data)
 * - Financial data cached inappropriately
 */
export const cacheTtlValidation = defineCheck({
  id: 'a4d3b82d-d599-4ff1-be42-1313b1c11a70',
  slug: 'cache-ttl-validation',
  scope: { languages: ['typescript'], concerns: ['backend', 'server'] },
  // Strings and comments are stripped before parsing: parseTtlsFromLine reads
  // real assignment syntax only, so an example `ttl: N` snippet inside a
  // doc comment (or a string literal) must never read as a live TTL.
  contentFilter: 'strip-strings-and-comments',

  confidence: 'medium',
  description: 'Validate cache TTL values for appropriate caching behavior',
  longDescription: `**Purpose:** Validates that cache TTL values fall within safe ranges, with stricter limits for financial and sensitive data.

**Detects:**
- TTL assignments (\`ttl = N\` or \`ttl: N\`) in files containing cache/redis/ttl keywords
- TTL < 5s (thundering herd risk)
- TTL > 60s for financial data lines containing \`balance\`, \`wallet\`, \`payment\`, \`transaction\`, \`escrow\`, \`price\`, \`amount\`, \`credit\`, \`debit\`
- TTL > 21600s for sensitive data lines containing \`session\`, \`token\`, \`auth\`, \`permission\`, \`role\`
- TTL > 86400s (24h) for general data
- Skips non-cache patterns like \`new Map()\`, \`new Set()\`, and metrics operations

**Why it matters:** Incorrect TTLs cause thundering herd problems (too short) or serve dangerously stale financial/auth data (too long).

**Scope:** General best practice. Analyzes each file individually via string parsing.`,
  tags: ['resilience', 'cache', 'performance'],
  fileTypes: ['ts'],

  analyze(content: string, filePath: string): CheckViolation[] {
    // Test fixtures intentionally exercise TTL boundary cases (too short,
    // too long, financial TTLs) to verify detection logic.
    if (isTestFile(filePath)) return [];

    logger.debug({
      evt: 'fitness.checks.cache_ttl_validation.analyze',
      msg: 'Analyzing file for cache TTL validation violations',
    });
    const violations: CheckViolation[] = [];

    // Skip files that don't have cache patterns
    if (!hasCachePatterns(content)) {
      return violations;
    }

    const lines = content.split('\n');
    for (const [i, line] of lines.entries()) {
      if (!line || isNonCachePattern(line)) {
        continue;
      }

      for (const { ttl, matchText, context } of parseTtlsFromLine(line)) {
        // Classify from the window around THIS occurrence, not the whole line.
        const isFinancialData = isFinancialDataLine(context);
        const isSensitiveData = isSensitiveDataLine(context);

        const violation = detectTtlViolation(ttl, isFinancialData, isSensitiveData);
        if (!violation) continue;

        const lineNumber = i + 1;
        violations.push({
          line: lineNumber,
          column: 0,
          message: violation.message,
          severity: violation.severity,
          suggestion: violation.suggestion,
          match: matchText,
          type: violation.patternId,
          filePath,
        });
      }
    }

    return violations;
  },
});
