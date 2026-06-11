// @fitness-ignore-file recovery-patterns -- Check definition contains custom timeout pattern strings it detects
/**
 * @fileoverview Enforce use of canonical recovery patterns
 */

import { logger } from '@opensip-tools/core';
import { defineCheck, isCommentLine, type CheckViolation } from '@opensip-tools/fitness';

// =============================================================================
// PATTERN DEFINITIONS (inlined from config/patterns.ts)
// =============================================================================

/**
 * Pattern definition for detection.
 */
interface PatternDefinition {
  readonly id: string;
  readonly regex: RegExp;
  readonly message: string;
  readonly suggestion: string;
  readonly severity: 'error' | 'warning';
  readonly skipInComments?: boolean;
  readonly multiline?: boolean;
}

// Recovery patterns
const RECOVERY_PATTERNS: PatternDefinition[] = [
  {
    id: 'manual-retry-loop',
    // Pattern: for (let retry... or for (let numRetry...
    regex: /for\s{0,10}\(\s{0,10}let\s{1,10}\w{0,30}[Rr]etry/g,
    message: 'Manual retry loop detected',
    suggestion:
      'Use a shared recovery/retry utility with standardized backoff and jitter instead of manual retry loops',
    severity: 'error',
    skipInComments: true,
  },
  {
    id: 'manual-retry-while',
    // Pattern: while (x < retries) or while (x < maxRetries)
    regex: /while\s{0,10}\(\s{0,10}\w{1,30}\s{0,10}<\s{0,10}(?:max)?[Rr]etries?\s{0,10}\)/g,
    message: 'Manual retry while-loop detected',
    suggestion:
      'Use a shared recovery/retry utility with standardized backoff and jitter instead of manual retry loops',
    severity: 'error',
    skipInComments: true,
  },
  {
    id: 'custom-circuit-breaker',
    // Pattern: circuitState = or isOpen: or consecutiveFailures =
    regex: /(?:circuitState|isOpen|consecutiveFailures)\s{0,10}[=:]/g,
    message: 'Custom circuit breaker state detected',
    suggestion:
      'Use a shared recovery/retry utility with circuit breaker support instead of custom circuit breaker state',
    severity: 'error',
    skipInComments: true,
  },
  {
    id: 'custom-timeout',
    // Pattern: new Promise((resolve, reject) => { ... setTimeout ... reject
    regex:
      /new\s{1,10}Promise\s{0,10}\(\s{0,10}\(resolve,\s{0,10}reject\)\s{0,10}=>\s{0,10}\{[\s\S]{0,500}?setTimeout[\s\S]{0,500}?reject/g,
    message: 'Custom timeout wrapper detected',
    suggestion: 'Use a shared timeout utility instead of custom Promise-based timeout wrappers',
    severity: 'warning',
    skipInComments: true,
    multiline: true,
  },
];

// Cache patterns
const CACHE_PATTERNS: PatternDefinition[] = [
  {
    id: 'custom-cache-map',
    // Pattern: private cache = new Map or private readonly myCache: new Map
    regex:
      /private\s{1,10}(?:readonly\s{1,10})?\w{0,30}[Cc]ache\s{0,10}[=:]\s{0,10}new\s{1,10}Map/g,
    message: 'Custom Map-based cache detected',
    suggestion:
      'Use a shared cache abstraction with TTL management and eviction policies instead of custom Map-based caches',
    severity: 'warning',
    skipInComments: true,
  },
  {
    id: 'custom-cache-object',
    // Pattern: private cache = {} or private readonly myCache: {}
    regex: /private\s{1,10}(?:readonly\s{1,10})?\w{0,30}[Cc]ache\s{0,10}[=:]\s{0,10}\{\s{0,10}\}/g,
    message: 'Custom object-based cache detected',
    suggestion:
      'Use a shared cache abstraction with TTL management and eviction policies instead of custom object-based caches',
    severity: 'warning',
    skipInComments: true,
  },
];

// Rate limiter patterns
const RATE_LIMITER_PATTERNS: PatternDefinition[] = [
  {
    id: 'custom-rate-limiter',
    regex: /(?:requestCount|rateLimitWindow|tokensRemaining)\s{0,10}[=:]/g,
    message: 'Custom rate limiting detected',
    suggestion: 'Use a shared rate limiter instead of custom rate limiting implementations',
    severity: 'warning',
    skipInComments: true,
  },
];

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/** Check if file path matches exclusion pattern */
function matchesExclusionPattern(filePath: string, patterns: readonly string[]): boolean {
  logger.debug({
    evt: 'fitness.checks.recovery_patterns.matches_exclusion_pattern',
    msg: 'Checking if file path matches exclusion pattern',
  });
  for (const pattern of patterns) {
    // Convert glob pattern to simple substring match for common cases
    const normalizedPattern = pattern.replaceAll('**', '').replaceAll('*', '');
    if (normalizedPattern && filePath.includes(normalizedPattern)) {
      return true;
    }
  }
  return false;
}

function createViolation(
  pattern: PatternDefinition,
  lineNumber: number,
  matchText: string,
): CheckViolation {
  logger.debug({
    evt: 'fitness.checks.recovery_patterns.create_violation',
    msg: 'Creating violation record for detected pattern',
  });
  return {
    line: lineNumber,
    message: pattern.message,
    severity: pattern.severity,
    suggestion: pattern.suggestion,
    match: matchText,
    type: pattern.id,
  };
}

function detectMultilinePattern(content: string, pattern: PatternDefinition): CheckViolation[] {
  logger.debug({
    evt: 'fitness.checks.recovery_patterns.detect_multiline_pattern',
    msg: 'Detecting multiline pattern violations',
  });
  const violations: CheckViolation[] = [];
  pattern.regex.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = pattern.regex.exec(content)) !== null) {
    const lineNumber = content.slice(0, match.index).split('\n').length;
    violations.push(createViolation(pattern, lineNumber, match[0].slice(0, 100)));
  }

  return violations;
}

function detectSingleLinePattern(lines: string[], pattern: PatternDefinition): CheckViolation[] {
  logger.debug({
    evt: 'fitness.checks.recovery_patterns.detect_single_line_pattern',
    msg: 'Detecting single line pattern violations',
  });
  const violations: CheckViolation[] = [];

  for (const [i, line] of lines.entries()) {
    /* v8 ignore next -- defensive: lines.entries() never yields undefined */
    if (line === undefined) continue;
    if (pattern.skipInComments && isCommentLine(line)) continue;

    if (pattern.regex.global) {
      pattern.regex.lastIndex = 0;
    }

    const match = pattern.regex.exec(line);
    if (match) {
      violations.push(createViolation(pattern, i + 1, match[0]));
    }
  }

  return violations;
}

function detectPatternViolations(
  content: string,
  lines: string[],
  pattern: PatternDefinition,
): CheckViolation[] {
  logger.debug({
    evt: 'fitness.checks.recovery_patterns.detect_pattern_violations',
    msg: 'Detecting pattern violations for content',
  });
  if (pattern.regex.global) {
    pattern.regex.lastIndex = 0;
  }

  if (pattern.multiline) {
    return detectMultilinePattern(content, pattern);
  }

  return detectSingleLinePattern(lines, pattern);
}

function detectPatterns(
  content: string,
  filePath: string,
  patterns: PatternDefinition[],
  excludePaths: readonly string[],
): CheckViolation[] {
  logger.debug({
    evt: 'fitness.checks.recovery_patterns.detect_patterns',
    msg: 'Running pattern detection on file content',
  });
  if (matchesExclusionPattern(filePath, excludePaths)) {
    return [];
  }

  const lines = content.split('\n');
  const violations: CheckViolation[] = [];

  for (const pattern of patterns) {
    const patternViolations = detectPatternViolations(content, lines, pattern);
    for (const violation of patternViolations) {
      violations.push(violation);
    }
  }

  return violations;
}

// =============================================================================
// CHECK DEFINITIONS
// =============================================================================

/**
 * Check: resilience/recovery-patterns
 *
 * Ensures code uses a shared recovery/retry utility
 * instead of custom retry loops, circuit breakers, or timeout wrappers.
 */
export const recoveryPatterns = defineCheck({
  id: '64f07f7e-baed-4946-83be-2b8102a9f98b',
  slug: 'recovery-patterns',
  disabled: true,
  scope: { languages: ['typescript'], concerns: ['backend', 'server'] },
  contentFilter: 'strip-strings',

  confidence: 'medium',
  description: 'Enforce use of shared recovery/retry utilities instead of hand-rolled retry loops',
  longDescription: `**Purpose:** Prevents hand-rolled retry loops, circuit breakers, and timeout wrappers in favor of the canonical recovery module.

**Detects:**
- Manual retry for-loops: \`for (let *retry\` or \`for (let *Retry\`
- Manual retry while-loops: \`while (x < retries)\` or \`while (x < maxRetries)\`
- Custom circuit breaker state: \`circuitState =\`, \`isOpen:\`, \`consecutiveFailures =\`
- Custom timeout wrappers: \`new Promise((resolve, reject) => { ... setTimeout ... reject\` (multiline)
- Skips comment lines when \`skipInComments\` is set

**Why it matters:** Custom recovery logic duplicates proven patterns and lacks standardized backoff, jitter, and observability.

**Scope:** Codebase-specific convention. Analyzes each file individually via regex.`,
  tags: ['resilience', 'recovery', 'canonical'],
  fileTypes: ['ts'],

  analyze(content: string, filePath: string): CheckViolation[] {
    return detectPatterns(content, filePath, RECOVERY_PATTERNS, [
      'foundation/src/recovery',
      '__tests__',
    ]);
  },
});

/**
 * Check: resilience/no-custom-cache
 *
 * Ensures code uses a shared cache abstraction
 * instead of custom Map-based caches.
 */
export const noCustomCache = defineCheck({
  id: '4c389ae7-ea92-42ff-bcec-0eb9d5d69e3e',
  slug: 'no-custom-cache',
  disabled: true,
  description: 'Enforce use of a shared cache abstraction instead of custom Map-based caches',
  longDescription: `**Purpose:** Prevents custom Map- or object-based caches in favor of the canonical CacheClient from infrastructure.

**Detects:**
- \`private [readonly] *cache = new Map\` pattern (Map-based cache)
- \`private [readonly] *cache = {}\` pattern (object-based cache)
- Skips comment lines

**Why it matters:** Custom caches lack TTL management, eviction policies, distributed invalidation, and observability that the canonical CacheClient provides.

**Scope:** Codebase-specific convention. Analyzes each file individually via regex.`,
  tags: ['resilience', 'canonical', 'cache'],

  analyze(content: string, filePath: string): CheckViolation[] {
    return detectPatterns(content, filePath, CACHE_PATTERNS, [
      'infrastructure/src/cache',
      '__tests__',
    ]);
  },
});

/**
 * Check: resilience/no-custom-rate-limiter
 *
 * Ensures code uses a shared rate limiter
 * instead of custom rate limiting implementations.
 */
export const noCustomRateLimiter = defineCheck({
  id: '330407bb-d139-48f3-b51e-61516eb93929',
  slug: 'no-custom-rate-limiter',
  disabled: true,
  description:
    'Enforce use of a shared rate limiter instead of custom rate limiting implementations',
  longDescription: `**Purpose:** Prevents custom rate limiting implementations in favor of the canonical RateLimiter from infrastructure.

**Detects:**
- Custom rate limiter state variables: \`requestCount =\`, \`rateLimitWindow =\`, \`tokensRemaining =\`
- Skips comment lines

**Why it matters:** Custom rate limiters lack distributed coordination, sliding window accuracy, and configuration consistency that the canonical module provides.

**Scope:** Codebase-specific convention. Analyzes each file individually via regex.`,
  tags: ['resilience', 'canonical', 'rate-limiting'],

  analyze(content: string, filePath: string): CheckViolation[] {
    return detectPatterns(content, filePath, RATE_LIMITER_PATTERNS, [
      'infrastructure/src/rate-limiting',
      '__tests__',
    ]);
  },
});
