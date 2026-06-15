// @fitness-ignore-file cors-configuration -- Fitness check definition; regex patterns reference CORS tokens for detection purposes, not actual CORS configuration
/**
 * @fileoverview Validate CORS configuration follows security best practices
 */

import { logger } from '@opensip-cli/core';
import { defineCheck, type CheckViolation } from '@opensip-cli/fitness';

/**
 * Pre-compiled CORS security patterns for static code analysis.
 * These patterns are intentional and safe - they are used to detect CORS misconfigurations
 * in source code, not to parse untrusted user input. The patterns have bounded quantifiers
 * and do not have catastrophic backtracking issues.
 */
// Wildcard origin: origin: "*" or origin = "*"
const WILDCARD_ORIGIN_PATTERN = /origin\s{0,10}[:=]\s{0,10}(['"])\*\1/g;
// Wildcard origin with credentials (simplified to avoid backtracking)
const WILDCARD_WITH_CREDS_PATTERN =
  /origin\s{0,10}[:=]\s{0,10}(['"])\*\1[^}]{0,200}credentials\s{0,10}[:=]\s{0,10}true/gi;
// Reflecting origin without validation
const REFLECTING_ORIGIN_PATTERN = /origin\s{0,10}[:=]\s{0,10}(?:request|req)\.headers?\.origin/gi;
// All origins allowed
const ORIGIN_TRUE_PATTERN = /origin\s{0,10}[:=]\s{0,10}true/g;
// Missing credentials in CORS call (simplified)
const MISSING_CREDS_PATTERN = /cors\s{0,10}\([^)]{0,500}\)(?![^}]{0,200}credentials)/gi;

// Patterns that indicate CORS security issues
const CORS_SECURITY_PATTERNS = [
  // Wildcard origin
  {
    regex: WILDCARD_ORIGIN_PATTERN,
    message: 'CORS allows wildcard origin - specify allowed origins explicitly',
    suggestion:
      'Replace "*" with an array of allowed origins: origin: ["https://app.example.com", "https://admin.example.com"]. Use environment variables for different environments.',
    severity: 'error' as const,
  },
  // Wildcard origin with credentials
  {
    regex: WILDCARD_WITH_CREDS_PATTERN,
    message: 'CORS wildcard origin with credentials is dangerous - browsers block this combination',
    suggestion:
      'When using credentials: true, you must specify explicit origins. Browsers block wildcard origin with credentials for security.',
    severity: 'error' as const,
  },
  // Reflecting origin without validation
  {
    regex: REFLECTING_ORIGIN_PATTERN,
    message: 'CORS reflecting request origin without validation - validate against allowlist',
    suggestion:
      'Validate the origin against an allowlist before reflecting: const allowedOrigins = new Set([...]); origin: (origin, cb) => cb(null, allowedOrigins.has(origin))',
    severity: 'error' as const,
  },
  // All origins allowed in array
  {
    regex: ORIGIN_TRUE_PATTERN,
    message: 'CORS origin: true reflects any origin - specify allowed origins',
    suggestion:
      'Replace origin: true with an explicit list of allowed origins or a validation function.',
    severity: 'warning' as const,
  },
  // Missing credentials in potentially authenticated context
  {
    regex: MISSING_CREDS_PATTERN,
    message: 'CORS configuration may be missing credentials setting',
    suggestion:
      'If this API uses cookies or Authorization headers, add credentials: true to allow credentialed requests.',
    severity: 'warning' as const,
  },
];

/**
 * Check: security/cors-configuration
 *
 * Validates CORS configuration is properly restrictive.
 * Prevents overly permissive cross-origin access.
 */
export const corsConfiguration = defineCheck({
  id: '0ea65e8a-4ee3-43b5-9d7f-dc39fe6fafeb',
  slug: 'cors-configuration',
  disabled: true,
  scope: { languages: ['typescript'], concerns: ['backend', 'server'] },
  contentFilter: 'raw',

  confidence: 'medium',
  description: 'Validate CORS configuration follows security best practices',
  longDescription: `**Purpose:** Validates that CORS configuration is properly restrictive and does not allow overly permissive cross-origin access.

**Detects:**
- Wildcard origin: \`origin: "*"\` or \`origin = "*"\`
- Wildcard origin combined with \`credentials: true\` (browser-rejected but indicates misconfiguration)
- Reflecting request origin without validation: \`origin: request.headers.origin\`
- Blanket allow: \`origin: true\`
- CORS calls potentially missing \`credentials\` setting

**Why it matters:** Overly permissive CORS allows malicious websites to make authenticated requests to your API, enabling CSRF and data theft.

**Scope:** General best practice. Analyzes each file individually. Only scans files containing "cors".`,
  tags: ['security', 'cors', 'configuration'],
  fileTypes: ['ts'],

  analyze(content: string, filePath: string): CheckViolation[] {
    logger.debug({
      evt: 'fitness.checks.cors_configuration.analyze',
      msg: 'Analyzing file for CORS configuration issues',
    });
    // Only scan files that might contain CORS config
    if (!/cors/i.test(content)) {
      return [];
    }

    const violations: CheckViolation[] = [];
    const lines = content.split('\n');

    for (const [lineNum, line_] of lines.entries()) {
      const line = line_ ?? '';

      // Skip comments
      if (line.trim().startsWith('//') || line.trim().startsWith('*')) {
        continue;
      }

      for (const pattern of CORS_SECURITY_PATTERNS) {
        // Reset regex state
        pattern.regex.lastIndex = 0;
        const match = pattern.regex.exec(line);
        if (match) {
          violations.push({
            line: lineNum + 1,
            column: match.index,
            message: pattern.message,
            severity: pattern.severity,
            suggestion: pattern.suggestion,
            match: match[0],
            filePath,
          });
        }
      }
    }

    return violations;
  },
});
