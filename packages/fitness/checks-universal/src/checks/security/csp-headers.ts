// @fitness-ignore-file no-eval -- String literals referencing eval()/Function() in CSP check descriptions and suggestions, not actual usage
// @fitness-ignore-file fitness-ignore-validation -- Fitness-ignore directives reference internal check IDs that may not be statically resolvable
// @fitness-ignore-file csp-headers -- Fitness check definition, not production CSP configuration
/**
 * @fileoverview Validate Content Security Policy headers configuration
 */

import { logger } from '@opensip-cli/core';
import { defineCheck, isCommentLine, type CheckViolation } from '@opensip-cli/fitness';

/**
 * Match unsafe-inline CSP directive
 */
function matchUnsafeInline(line: string): RegExpExecArray | null {
  logger.debug({
    evt: 'fitness.checks.csp_headers.match_unsafe_inline',
    msg: 'Checking for unsafe-inline CSP directive',
  });
  return /['"`]unsafe-inline['"`]/i.exec(line);
}

/**
 * Match unsafe-eval CSP directive
 */
function matchUnsafeEval(line: string): RegExpExecArray | null {
  logger.debug({
    evt: 'fitness.checks.csp_headers.match_unsafe_eval',
    msg: 'Checking for unsafe-eval CSP directive',
  });
  return /['"`]unsafe-eval['"`]/i.exec(line);
}

/**
 * Match wildcard in CSP directive
 */
function matchCspWildcard(line: string): RegExpExecArray | null {
  logger.debug({
    evt: 'fitness.checks.csp_headers.match_csp_wildcard',
    msg: 'Checking for wildcard in CSP directive',
  });
  const lowerLine = line.toLowerCase();
  const cspDirectives = ['default-src', 'script-src', 'style-src', 'img-src', 'connect-src'];
  for (const directive of cspDirectives) {
    if (lowerLine.includes(directive)) {
      const match = /['"]\*['"]/i.exec(line);
      if (match) return match;
    }
  }
  return null;
}

/**
 * Match CSP config missing default-src
 */
function matchMissingDefaultSrc(line: string): RegExpExecArray | null {
  logger.debug({
    evt: 'fitness.checks.csp_headers.match_missing_default_src',
    msg: 'Checking for missing default-src CSP directive',
  });
  const lowerLine = line.toLowerCase();
  if (!lowerLine.includes('contentsecuritypolicy')) return null;
  if (lowerLine.includes('defaultsrc') || lowerLine.includes('default-src')) return null;
  // @fitness-ignore-next-line sonarjs-regular-expr -- Simple pattern with no backtracking; \s* followed by character class, then literal
  return /contentSecurityPolicy\s*[:=]\s*\{/i.exec(line);
}

/**
 * Match data: URI in script-src
 */
function matchDataUriInScriptSrc(line: string): RegExpExecArray | null {
  logger.debug({
    evt: 'fitness.checks.csp_headers.match_data_uri_in_script_src',
    msg: 'Checking for data URI in script-src directive',
  });
  const lowerLine = line.toLowerCase();
  if (!lowerLine.includes('script-src')) return null;
  return /['"`]data:['"`]/i.exec(line);
}

// Patterns that indicate CSP issues
const CSP_SECURITY_PATTERNS = [
  // Unsafe inline scripts
  {
    match: matchUnsafeInline,
    message: "CSP 'unsafe-inline' detected - avoid inline scripts/styles if possible",
    suggestion:
      "Use nonces or hashes instead of 'unsafe-inline'. For scripts, use script-src 'nonce-{random}' and add nonce attribute to script tags. For styles, extract to external stylesheets.",
    severity: 'warning' as const,
  },
  // Unsafe eval
  {
    match: matchUnsafeEval,
    message: "CSP 'unsafe-eval' detected - this allows eval() and similar dangerous functions",
    suggestion:
      "Remove 'unsafe-eval' and refactor code that uses eval(), new Function(), or setTimeout/setInterval with string arguments. Use proper JSON parsing and precompiled templates.",
    severity: 'error' as const,
  },
  // Wildcard in CSP
  {
    match: matchCspWildcard,
    message: 'CSP wildcard (*) directive detected - use specific origins',
    suggestion:
      'Replace wildcard (*) with specific trusted origins. For images/fonts, list CDN domains explicitly. For API calls, list your API domains.',
    severity: 'warning' as const,
  },
  // Missing default-src
  {
    match: matchMissingDefaultSrc,
    message: 'CSP configuration may be missing default-src directive',
    suggestion:
      'Add default-src: ["\'self\'"] as a fallback policy. This restricts resources to same-origin by default unless overridden by more specific directives.',
    severity: 'warning' as const,
  },
  // data: URI in script-src (dangerous)
  {
    match: matchDataUriInScriptSrc,
    message: "CSP script-src with 'data:' URI is dangerous - can execute arbitrary code",
    suggestion:
      "Remove 'data:' from script-src. Data URIs in scripts allow arbitrary code execution, defeating the purpose of CSP. Move scripts to external files or use nonces.",
    severity: 'error' as const,
  },
];

// Files likely to contain CSP configuration
const CSP_CONFIG_PATTERNS = ['helmet', 'contentsecuritypolicy', 'content-security-policy', 'csp'];

/**
 * Check if content contains CSP configuration references
 */
function containsCspContent(content: string): boolean {
  logger.debug({
    evt: 'fitness.checks.csp_headers.contains_csp_content',
    msg: 'Checking if content contains CSP configuration references',
  });
  const lowerContent = content.toLowerCase();
  return CSP_CONFIG_PATTERNS.some((pattern) => lowerContent.includes(pattern));
}

/**
 * Check: security/csp-headers
 *
 * Validates Content Security Policy headers are properly configured.
 * Prevents XSS and other injection attacks.
 */
export const cspHeaders = defineCheck({
  id: 'ab02c5a5-881d-4004-a655-0ec73944bbe1',
  slug: 'csp-headers',
  disabled: true,
  scope: { languages: ['typescript', 'tsx'], concerns: ['frontend', 'ui'] },
  contentFilter: 'raw',

  confidence: 'medium',
  description: 'Validate Content Security Policy headers configuration',
  longDescription: `**Purpose:** Validates that Content Security Policy (CSP) headers are configured securely, preventing XSS and code injection attacks.

**Detects:**
- \`'unsafe-inline'\` in CSP directives (allows inline scripts/styles)
- \`'unsafe-eval'\` in CSP directives (allows eval() and similar)
- Wildcard \`*\` in CSP source directives (default-src, script-src, style-src, img-src, connect-src)
- Missing \`default-src\` in contentSecurityPolicy configuration objects
- \`data:\` URI in script-src (allows arbitrary code execution)

**Why it matters:** Weak CSP directives undermine the primary browser defense against XSS. A properly configured CSP blocks injected scripts even when other defenses fail.

**Scope:** General best practice. Analyzes each file individually. Only scans files containing helmet, contentSecurityPolicy, or csp references.`,
  tags: ['security', 'csp', 'headers', 'xss'],
  fileTypes: ['ts'],

  analyze(content: string, filePath: string): CheckViolation[] {
    logger.debug({
      evt: 'fitness.checks.csp_headers.analyze',
      msg: 'Analyzing file for CSP header configuration issues',
    });
    // Only scan files that might contain CSP config
    if (!containsCspContent(content)) {
      return [];
    }

    const violations: CheckViolation[] = [];
    const lines = content.split('\n');

    for (const [lineNum, line_] of lines.entries()) {
      const line = line_ ?? '';

      // Skip comments
      if (isCommentLine(line)) {
        continue;
      }

      for (const pattern of CSP_SECURITY_PATTERNS) {
        const match = pattern.match(line);
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
