// @fitness-ignore-file unused-config-options -- Config options reserved for future use or environment-specific
/**
 * @fileoverview No Legacy Code check
 *
 * Detects backwards compatibility code, deprecated patterns, legacy wrappers,
 * and temporary workarounds that should be cleaned up.
 *
 * Detected patterns:
 * - @deprecated tags
 * - Compatibility layer classes/functions
 * - Legacy wrapper patterns
 * - Migration utilities
 * - Version compatibility checks
 * - Backwards compatibility comments
 * - Shim/adapter patterns for compatibility
 */

import { defineCheck, type CheckViolation } from '@opensip-tools/fitness'

// =============================================================================
// CONSTANTS
// =============================================================================

const EXCLUDE_PATTERNS = [
  /fitness/,
  /test/,
  /spec/,
  /docs/,
  /reports/,
  /versioning/, // Exclude versioning module - contains legitimate schema migration utilities
]

// =============================================================================
// TYPES
// =============================================================================

type ViolationType =
  | 'deprecated-tag'
  | 'deprecated-comment'
  | 'compatibility-layer'
  | 'migration-utility'
  | 'legacy-code-path'
  | 'version-check'
  | 'backwards-compat-comment'
  | 'temporary-workaround'
  | 'shim-adapter'

/**
 * Pattern matcher function type - used instead of regex for complex patterns
 * to avoid ReDoS vulnerabilities and reduce complexity.
 */
type PatternMatcher = (line: string) => boolean

interface PatternConfig {
  /**
   * Pattern can be either a RegExp (for simple patterns) or a function (for complex patterns).
   * Use functions when: regex would be vulnerable to ReDoS, regex complexity > 20, or when
   * string operations are more readable.
   */
  pattern: RegExp | PatternMatcher
  type: ViolationType
  severity: 'ERROR' | 'WARNING'
  message: string
  suggestion?: string
  keywords?: string[] // For pre-filtering with string checks
}

// =============================================================================
// PATTERN MATCHERS
// =============================================================================

/**
 * Detects JSDoc tag lines starting with the legacy marker that flags
 * obsolete code paths. Uses string operations to avoid regex complexity.
 */
function isLegacyJsdocLine(line: string): boolean {
  const trimmed = line.trim()
  const normalized = trimmed.startsWith('*') ? trimmed.slice(1).trim() : trimmed
  const marker = '@' + 'deprecated'
  return normalized.toLowerCase().startsWith(marker)
}

/**
 * Matches declarations with "compatibilitylayer" in the name.
 * Pattern: (class|function|const|let|var) SomeCompatibilityLayerName
 */
function matchCompatibilityLayer(line: string): boolean {
  const lowerLine = line.toLowerCase()
  if (!lowerLine.includes('compatibilitylayer')) return false
  const declarationKeywords = ['class ', 'function ', 'const ', 'let ', 'var ']
  return declarationKeywords.some((keyword) => lowerLine.includes(keyword))
}

/**
 * Matches declarations with "legacywrapper" in the name.
 */
function matchLegacyWrapper(line: string): boolean {
  const lowerLine = line.toLowerCase()
  if (!lowerLine.includes('legacywrapper')) return false
  const declarationKeywords = ['class ', 'function ', 'const ', 'let ', 'var ']
  return declarationKeywords.some((keyword) => lowerLine.includes(keyword))
}

/**
 * Matches declarations with "backwardcompat" in the name.
 */
function matchBackwardCompat(line: string): boolean {
  const lowerLine = line.toLowerCase()
  if (!lowerLine.includes('backwardcompat')) return false
  const declarationKeywords = ['function ', 'const ', 'let ', 'var ']
  return declarationKeywords.some((keyword) => lowerLine.includes(keyword))
}

/**
 * Matches version compatibility checks.
 * Pattern: if (version <comparison>) { ... compatibility ... }
 */
function matchVersionCheck(line: string): boolean {
  const lowerLine = line.toLowerCase()
  // Must have 'if' with 'version' and 'compatibility'
  if (!lowerLine.includes('if') || !lowerLine.includes('version')) return false
  if (!lowerLine.includes('compatibility')) return false
  // Check for comparison operators near 'version'
  const versionIdx = lowerLine.indexOf('version')
  const afterVersion = lowerLine.slice(versionIdx)
  // Simple check for comparison operators in first 20 chars after 'version'
  const checkPortion = afterVersion.slice(0, 20)
  return (
    checkPortion.includes('<') ||
    checkPortion.includes('>') ||
    checkPortion.includes('=') ||
    checkPortion.includes('!')
  )
}

/**
 * Matches HACK or issue-marker comments with workaround keywords.
 */
function matchTemporaryWorkaround(line: string): boolean {
  const lowerLine = line.toLowerCase()
  const hasMarker = lowerLine.includes('hack') || lowerLine.includes('fixme')
  if (!hasMarker) return false
  return (
    lowerLine.includes('before launch') ||
    lowerLine.includes('temporary') ||
    lowerLine.includes('workaround')
  )
}

/**
 * Matches backwards compatibility comments.
 * Excludes: "backward compatible way" (semantic versioning descriptions)
 */
function matchBackwardsCompatComment(line: string): boolean {
  const lowerLine = line.toLowerCase()

  // Check for "backwards compatib" or "backward compatib" but exclude "compatible way"
  const hasBackwardCompat = lowerLine.includes('backward') && lowerLine.includes('compatib')
  const isLegitimateDescription = lowerLine.includes('compatible way')
  if (hasBackwardCompat && !isLegitimateDescription) {
    return true
  }

  // Check other patterns
  if (lowerLine.includes('legacy support')) return true
  if (lowerLine.includes('deprecated but kept')) return true
  if (lowerLine.includes('alias for') && lowerLine.includes('compat')) return true

  return false
}

/**
 * Matches shim declarations (whole word only to avoid false positives like "kalshiModule").
 */
function matchShimAdapter(line: string): boolean {
  const lowerLine = line.toLowerCase()
  if (!/\bshim\b/.test(lowerLine)) return false
  const declarationKeywords = ['class ', 'function ', 'const ', 'let ', 'var ']
  return declarationKeywords.some((keyword) => lowerLine.includes(keyword))
}

// =============================================================================
// PATTERN CONFIGURATION
// =============================================================================

const COMPATIBILITY_PATTERNS: readonly PatternConfig[] = [
  // Only catch actual @deprecated JSDoc tags in production code
  {
    pattern: isLegacyJsdocLine,
    type: 'deprecated-tag',
    severity: 'ERROR',
    message:
      'Found @deprecated JSDoc tag - remove this deprecated code and update all callers in the same PR',
    suggestion: 'Remove the deprecated code entirely and update all call sites in the same PR',
    keywords: ['deprecated'],
  },

  // Very specific backwards compatibility class/function names
  {
    pattern: matchCompatibilityLayer,
    type: 'compatibility-layer',
    severity: 'ERROR',
    message: 'Found compatibility layer class/function - refactor directly instead',
    suggestion: 'Refactor to use the new implementation directly without a compatibility layer',
    keywords: ['compatibility'],
  },
  {
    pattern: matchLegacyWrapper,
    type: 'legacy-code-path',
    severity: 'ERROR',
    message: 'Found legacy wrapper class/function - remove and update all dependent code',
    suggestion:
      'Remove the legacy wrapper and update all dependent code to use the modern implementation',
    keywords: ['legacy'],
  },

  // Specific backwards compatibility utility patterns
  {
    pattern: matchBackwardCompat,
    type: 'migration-utility',
    severity: 'ERROR',
    message: 'Found backwards compatibility utility - not needed during pre-launch phase',
    suggestion: 'Remove backwards compatibility utilities and use direct implementations',
    keywords: ['backward', 'compat'],
  },

  // Specific version compatibility checks in code
  {
    pattern: matchVersionCheck,
    type: 'version-check',
    severity: 'ERROR',
    message: 'Found version compatibility check - not needed during pre-launch',
    suggestion: 'Remove version checks and use a single implementation',
    keywords: ['version', 'compatibility'],
  },

  // Temporary workarounds and hacks
  {
    pattern: matchTemporaryWorkaround,
    type: 'temporary-workaround',
    severity: 'ERROR',
    message: 'Found temporary workaround - implement permanent solution before launch',
    suggestion: 'Replace temporary workaround with a permanent, production-ready solution',
    keywords: ['HACK', 'FIXME', 'temporary', 'workaround'],
  },

  // Backwards compatibility comments
  // Excludes: semantic versioning descriptions ("backward compatible way"), library compatibility
  {
    pattern: matchBackwardsCompatComment,
    type: 'backwards-compat-comment',
    severity: 'WARNING',
    message: 'Found backwards compatibility comment - remove legacy code paths',
    suggestion: 'Remove the backwards compatibility code and associated comments',
    keywords: ['backward', 'compat', 'legacy', 'deprecated'],
  },

  // Shim patterns for compatibility (removed 'adapter' as it causes too many false positives)
  {
    pattern: matchShimAdapter,
    type: 'shim-adapter',
    severity: 'WARNING',
    message: 'Found shim pattern - verify this is not for backwards compatibility',
    suggestion:
      "If this is for backwards compatibility, remove it. If it's a legitimate design pattern, add a comment explaining why",
    keywords: ['shim'],
  },
]

// =============================================================================
// ANALYSIS FUNCTIONS
// =============================================================================

/**
 * Check if a file should be excluded from scanning
 */
function shouldExcludeFile(relativePath: string): boolean {
  return EXCLUDE_PATTERNS.some((pattern) => pattern.test(relativePath))
}

/**
 * Check if a line matches a pattern (with keyword pre-filtering)
 */
function matchPattern(line: string, patternConfig: PatternConfig): boolean {
  // Use string checks before pattern matching for performance
  if (patternConfig.keywords) {
    const lowerLine = line.toLowerCase()
    const hasKeyword = patternConfig.keywords.some((keyword) =>
      lowerLine.includes(keyword.toLowerCase()),
    )
    if (!hasKeyword) {
      return false // Skip pattern matching if keywords not present
    }
  }

  // Support both RegExp and function patterns
  if (typeof patternConfig.pattern === 'function') {
    return patternConfig.pattern(line)
  }
  return patternConfig.pattern.test(line)
}

interface ViolationResult {
  line: number
  type: ViolationType
  message: string
  suggestion: string | undefined
  severity: 'ERROR' | 'WARNING'
  match: string
}

/**
 * Scan file content for compatibility violations
 */
function scanFileForViolations(content: string): ViolationResult[] {
  const violations: ViolationResult[] = []

  const lines = content.split('\n')

  for (const [lineIndex, line] of lines.entries()) {
    if (!line) continue
    const lineNumber = lineIndex + 1

    for (const patternConfig of COMPATIBILITY_PATTERNS) {
      if (matchPattern(line, patternConfig)) {
        violations.push({
          line: lineNumber,
          type: patternConfig.type,
          message: patternConfig.message,
          suggestion: patternConfig.suggestion,
          severity: patternConfig.severity,
          match: line.trim(),
        })
        break // Only report first matching pattern per line
      }
    }
  }

  return violations
}

// =============================================================================
// CHECK DEFINITION
// =============================================================================

/**
 * Check: quality/no-legacy-code
 *
 * Ensures no backwards compatibility code exists during pre-launch phase.
 * This is a pre-launch codebase with no external consumers, so we fix things
 * properly without maintaining backwards compatibility.
 *
 */
export const noLegacyCode = defineCheck({
  id: '3a27c17d-a926-46a8-864d-610de1a385eb',
  slug: 'no-legacy-code',
  scope: { languages: ['typescript'], concerns: ['backend', 'frontend', 'cli'] },
  contentFilter: 'raw',

  confidence: 'medium',
  description: 'Detects legacy code, backwards compatibility layers, and temporary workarounds',
  longDescription: `**Purpose:** Detects backwards compatibility code, deprecated patterns, and legacy workarounds that add unnecessary complexity.

**Detects:**
- \`@deprecated\` JSDoc tags in production code
- Declarations containing \`CompatibilityLayer\`, \`LegacyWrapper\`, \`BackwardCompat\`, or \`Shim\` in class/function/variable names
- Version compatibility checks (\`if (version ...)\` with \`compatibility\`)
- Temporary workaround comments (\`HACK\`/\`FIXME\` with \`before launch\`/\`temporary\`/\`workaround\`)
- Backwards compatibility comments (\`legacy support\`, \`deprecated but kept\`, \`alias for ... compat\`)

**Why it matters:** Legacy compatibility code adds complexity, obscures intent, and accumulates tech debt. Removing it keeps the codebase clean and maintainable.

**Scope:** General best practice. Analyzes each file individually (\`analyze\`). Targets production files, excluding test/docs/versioning paths.`,
  tags: ['code-quality', 'compliance', 'quality'],
  fileTypes: ['ts', 'tsx'],
  disabled: false,

  analyze(content, filePath): CheckViolation[] {
    const relativePath = filePath

    // Skip excluded files
    if (shouldExcludeFile(relativePath)) {
      return []
    }

    // Quick filter: skip files without any keywords
    const lowerContent = content.toLowerCase()
    const hasAnyKeyword = COMPATIBILITY_PATTERNS.some((p) =>
      p.keywords?.some((kw) => lowerContent.includes(kw.toLowerCase())),
    )

    if (!hasAnyKeyword) {
      return []
    }

    const results = scanFileForViolations(content)

    return results.map((v) => ({
      line: v.line,
      column: 0,
      message: v.message,
      severity: v.severity === 'ERROR' ? 'error' : 'warning',
      type: v.type,
      suggestion:
        v.suggestion ??
        'Remove this backwards compatibility code and implement the proper solution directly',
      match: v.match,
    }))
  },
})
