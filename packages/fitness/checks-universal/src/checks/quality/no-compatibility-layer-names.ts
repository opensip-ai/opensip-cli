/**
 * @fileoverview Detects compatibility-layer / legacy-wrapper /
 * backward-compat declarations.
 *
 * Catches class/function/variable declarations whose names contain
 * `CompatibilityLayer`, `LegacyWrapper`, or `BackwardCompat`. Refactor
 * to the modern implementation directly; don't keep both paths alive
 * behind a wrapper.
 *
 * Extracted from the former `no-legacy-code` umbrella in Phase C4.
 */

import { defineCheck, type CheckViolation } from '@opensip-cli/fitness';

const EXCLUDE_PATTERNS = [/fitness/, /test/, /spec/, /docs/, /reports/, /versioning/];

function shouldExcludeFile(relativePath: string): boolean {
  return EXCLUDE_PATTERNS.some((pattern) => pattern.test(relativePath));
}

const DECLARATION_KEYWORDS = ['class ', 'function ', 'const ', 'let ', 'var '];

interface NameMatcher {
  needle: string;
  type: 'compatibility-layer' | 'legacy-code-path' | 'migration-utility';
  message: string;
  suggestion: string;
  // BackwardCompat allows function/const/let/var but not class — preserves
  // the original umbrella's behaviour.
  allowClass: boolean;
}

const MATCHERS: readonly NameMatcher[] = [
  {
    needle: 'compatibilitylayer',
    type: 'compatibility-layer',
    message: 'Found compatibility layer class/function - refactor directly instead',
    suggestion: 'Refactor to use the new implementation directly without a compatibility layer',
    allowClass: true,
  },
  {
    needle: 'legacywrapper',
    type: 'legacy-code-path',
    message: 'Found legacy wrapper class/function - remove and update all dependent code',
    suggestion:
      'Remove the legacy wrapper and update all dependent code to use the modern implementation',
    allowClass: true,
  },
  {
    needle: 'backwardcompat',
    type: 'migration-utility',
    message: 'Found backwards compatibility utility - not needed during pre-launch phase',
    suggestion: 'Remove backwards compatibility utilities and use direct implementations',
    allowClass: false,
  },
];

function matchesDeclaration(line: string, matcher: NameMatcher): boolean {
  const lower = line.toLowerCase();
  if (!lower.includes(matcher.needle)) return false;
  return DECLARATION_KEYWORDS.some((kw) => {
    if (!matcher.allowClass && kw === 'class ') return false;
    return lower.includes(kw);
  });
}

export const noCompatibilityLayerNames = defineCheck({
  id: 'e39edca8-ee4d-4de8-9a39-655f4d0eb86d',
  slug: 'no-compatibility-layer-names',
  scope: { languages: ['typescript'], concerns: ['backend', 'frontend', 'cli'] },
  contentFilter: 'raw',
  confidence: 'medium',
  description: 'Detects compatibility-layer, legacy-wrapper, and backward-compat declarations',
  longDescription: `**Purpose:** Flags class/function/variable declarations whose names announce themselves as a compatibility layer. Once a refactor is done, the wrapper should be removed and call sites updated to the new implementation directly.

**Detects:**
- Declarations containing \`CompatibilityLayer\` (class/function/const/let/var)
- Declarations containing \`LegacyWrapper\` (class/function/const/let/var)
- Declarations containing \`BackwardCompat\` (function/const/let/var; \`class\` excluded — too rare to be reliable)

**Why it matters:** Wrapper names signal that two implementations are alive at once. Resolving the wrapper to a single direct implementation removes a source of drift.

**Scope:** General best practice. Analyzes each file individually; excludes test/docs/versioning paths.`,
  tags: ['code-quality', 'compliance', 'quality'],
  fileTypes: ['ts', 'tsx'],

  analyze(content, filePath): CheckViolation[] {
    if (shouldExcludeFile(filePath)) return [];

    const lower = content.toLowerCase();
    const hasAnyNeedle = MATCHERS.some((m) => lower.includes(m.needle));
    if (!hasAnyNeedle) return [];

    const violations: CheckViolation[] = [];
    const lines = content.split('\n');

    for (const [i, line] of lines.entries()) {
      if (!line) continue;
      for (const matcher of MATCHERS) {
        if (matchesDeclaration(line, matcher)) {
          violations.push({
            line: i + 1,
            column: 0,
            message: matcher.message,
            severity: 'error',
            type: matcher.type,
            suggestion: matcher.suggestion,
            match: line.trim(),
          });
          break; // one finding per line
        }
      }
    }

    return violations;
  },
});
