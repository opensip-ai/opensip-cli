// @fitness-ignore-file toctou-race-condition -- TOCTOU acceptable in this non-concurrent context
// @fitness-ignore-file duplicate-interface-detection -- similar interfaces across module boundaries
// @fitness-ignore-file duplicate-implementation-detection -- similar patterns across diagnostic modules
/**
 * @fileoverview Comment Quality Check
 *
 * This check detects banned comment patterns:
 * - Debt markers (incomplete task markers, work-in-progress tags)
 * - AI-generation metadata (comments must stand on their own merit)
 * - Process/planning artifacts (Phase X, Sprint X, version stamps)
 *
 * All detected patterns are errors, not warnings. This supersedes quality/no-todos.
 */

import { defineCheck, type CheckViolation } from '@opensip-tools/fitness'

// =============================================================================
// TYPES
// =============================================================================

type ViolationType =
  | 'DEBT_MARKER_TODO'
  | 'DEBT_MARKER_FIXME'
  | 'DEBT_MARKER_HACK'
  | 'DEBT_MARKER_XXX'
  | 'DEBT_MARKER_OPTIMIZE'
  | 'AI_METADATA'
  | 'PROCESS_ARTIFACT'

interface PatternDef {
  regex: RegExp
  type: ViolationType
  fix: string
}

// =============================================================================
// PRE-COMPILED REGEX PATTERNS (for safety and performance)
// =============================================================================

/** Maximum line length for regex matching */
const MAX_LINE_LENGTH = 500

/**
 * Safely truncate a line for regex matching.
 */
function safeLineForRegex(line: string): string {
  return line.length > MAX_LINE_LENGTH ? line.slice(0, MAX_LINE_LENGTH) : line
}

/** Fix message for debt markers */
const DEBT_MARKER_FIX = 'Implement the incomplete task or delete the comment'

// Debt marker patterns - single line comments
// Using bounded patterns with word boundaries
const SINGLE_LINE_TODO_PATTERN = /\/\/\s{0,10}TODO\b/i
const SINGLE_LINE_FIXME_PATTERN = /\/\/\s{0,10}FIXME\b/i
const SINGLE_LINE_HACK_PATTERN = /\/\/\s{0,10}HACK\b/i
const SINGLE_LINE_XXX_PATTERN = /\/\/\s{0,10}XXX\b/i
const SINGLE_LINE_OPTIMIZE_PATTERN = /\/\/\s{0,10}OPTIMIZE\b/i

// Debt marker patterns - block comments (bounded asterisks)
const BLOCK_TODO_PATTERN = /\/\*{1,5}\s{0,10}TODO\b/i
const BLOCK_FIXME_PATTERN = /\/\*{1,5}\s{0,10}FIXME\b/i
const BLOCK_HACK_PATTERN = /\/\*{1,5}\s{0,10}HACK\b/i
const BLOCK_XXX_PATTERN = /\/\*{1,5}\s{0,10}XXX\b/i
const BLOCK_OPTIMIZE_PATTERN = /\/\*{1,5}\s{0,10}OPTIMIZE\b/i

// AI-generation metadata patterns
// Using word boundaries and bounded quantifiers
const AI_GENERATED_BY_SINGLE_PATTERN =
  /\/\/[^/]{0,200}\b(?:generated|created|written|assisted)\s{1,5}by\s{1,5}(?:ai|chatgpt|claude|copilot|gpt|llm|openai|anthropic|gemini|bard)\b/i
const AI_TOOL_ACTION_SINGLE_PATTERN =
  /\/\/[^/]{0,200}\b(?:ai|chatgpt|claude|copilot|gpt|llm)\s{1,5}(?:generated|created|wrote|suggested|assisted)\b/i
const AI_GENERATED_BY_BLOCK_PATTERN =
  /\/\*{1,5}[^*]{0,200}\b(?:generated|created|written|assisted)\s{1,5}by\s{1,5}(?:ai|chatgpt|claude|copilot|gpt|llm|openai|anthropic|gemini|bard)\b/i

// Process/planning artifact patterns (bounded quantifiers)
const PHASE_PATTERN = /\/\/\s{0,5}Phase\s{1,5}\d{1,3}\s{0,5}(?:Enhancement|Implementation|:|$)/i
const SPRINT_PATTERN = /\/\/\s{0,5}Sprint\s{1,5}\d{1,5}\b/i
const VERSION_STAMP_PATTERN = /\/\/\s{0,5}v\d{1,3}\.\d{1,3}(?:\.\d{1,5})?\s{0,5}$/i
const ADDED_IN_VERSION_PATTERN = /\/\/\s{0,5}Added\s{1,5}in\s{1,5}v\d{1,5}\b/i
const DATE_STAMP_PATTERN = /\/\/\s{0,5}Updated?\s{1,5}\d{4}-\d{2}-\d{2}\b/i

// Exclusion pattern for algorithm step comments
const ALGORITHM_PHASE_PATTERN = /\/\/\s{0,5}Phase\s{1,5}\d{1,3}\s{0,5}:\s{0,5}\w{1,50}/i

const BANNED_PATTERNS: PatternDef[] = [
  // Debt markers (banned in production) - single line
  { regex: SINGLE_LINE_TODO_PATTERN, type: 'DEBT_MARKER_TODO', fix: DEBT_MARKER_FIX },
  { regex: SINGLE_LINE_FIXME_PATTERN, type: 'DEBT_MARKER_FIXME', fix: DEBT_MARKER_FIX },
  { regex: SINGLE_LINE_HACK_PATTERN, type: 'DEBT_MARKER_HACK', fix: DEBT_MARKER_FIX },
  { regex: SINGLE_LINE_XXX_PATTERN, type: 'DEBT_MARKER_XXX', fix: DEBT_MARKER_FIX },
  { regex: SINGLE_LINE_OPTIMIZE_PATTERN, type: 'DEBT_MARKER_OPTIMIZE', fix: DEBT_MARKER_FIX },

  // Debt markers (banned in production) - block comments
  { regex: BLOCK_TODO_PATTERN, type: 'DEBT_MARKER_TODO', fix: DEBT_MARKER_FIX },
  { regex: BLOCK_FIXME_PATTERN, type: 'DEBT_MARKER_FIXME', fix: DEBT_MARKER_FIX },
  { regex: BLOCK_HACK_PATTERN, type: 'DEBT_MARKER_HACK', fix: DEBT_MARKER_FIX },
  { regex: BLOCK_XXX_PATTERN, type: 'DEBT_MARKER_XXX', fix: DEBT_MARKER_FIX },
  { regex: BLOCK_OPTIMIZE_PATTERN, type: 'DEBT_MARKER_OPTIMIZE', fix: DEBT_MARKER_FIX },

  // AI-generation metadata
  {
    regex: AI_GENERATED_BY_SINGLE_PATTERN,
    type: 'AI_METADATA',
    fix: 'Remove AI-generation metadata; comments must stand on their own merit',
  },
  {
    regex: AI_TOOL_ACTION_SINGLE_PATTERN,
    type: 'AI_METADATA',
    fix: 'Remove AI-generation metadata; comments must stand on their own merit',
  },
  {
    regex: AI_GENERATED_BY_BLOCK_PATTERN,
    type: 'AI_METADATA',
    fix: 'Remove AI-generation metadata; comments must stand on their own merit',
  },

  // Process/planning artifacts
  {
    regex: PHASE_PATTERN,
    type: 'PROCESS_ARTIFACT',
    fix: 'Remove planning artifact; use backlog for tracking future work',
  },
  {
    regex: SPRINT_PATTERN,
    type: 'PROCESS_ARTIFACT',
    fix: 'Remove planning artifact; sprint references are not useful to code readers',
  },
  {
    regex: VERSION_STAMP_PATTERN,
    type: 'PROCESS_ARTIFACT',
    fix: 'Remove version stamp; git history tracks this information',
  },
  {
    regex: ADDED_IN_VERSION_PATTERN,
    type: 'PROCESS_ARTIFACT',
    fix: 'Remove version stamp; git history tracks this information',
  },
  {
    regex: DATE_STAMP_PATTERN,
    type: 'PROCESS_ARTIFACT',
    fix: 'Remove date stamp; git history tracks this information',
  },
]

// Patterns to exclude (false positives)
const EXCLUDE_PATTERNS: RegExp[] = [
  // Algorithm step comments like "Phase 1: Try primary operation" are allowed
  ALGORITHM_PHASE_PATTERN,
]

// =============================================================================
// ANALYSIS FUNCTIONS
// =============================================================================

interface CommentViolation {
  line: number
  type: ViolationType
  comment: string
  fix: string
}

/**
 * Analyze a file for comment quality violations
 */
function analyzeFileContent(content: string): CommentViolation[] {
  const violations: CommentViolation[] = []
  const lines = content.split('\n')

  for (const [i, line] of lines.entries()) {
    if (!line) continue

    checkLineForComments(line, i + 1, violations)
  }

  return violations
}

function checkLineForComments(
  line: string,
  lineNumber: number,
  violations: CommentViolation[],
): void {
  /* v8 ignore next 4 -- defensive: callers always pass an array */
  // Validate array parameter
  if (!Array.isArray(violations)) {
    return
  }

  // Apply line length safety for regex matching
  const safeLine = safeLineForRegex(line)

  // Check if line matches any exclusion pattern (false positive avoidance)
  const isExcluded = EXCLUDE_PATTERNS.some((pattern) => pattern.test(safeLine))
  if (isExcluded) return

  // Check against banned patterns
  for (const { regex, type, fix } of BANNED_PATTERNS) {
    if (regex.test(safeLine)) {
      violations.push({
        line: lineNumber,
        type,
        comment: safeLine.trim(),
        fix,
      })
      break // Only report first matching pattern per line
    }
  }
}

// =============================================================================
// CHECK DEFINITION
// =============================================================================

/**
 * Check: quality/comment-quality
 *
 * Detects banned comment patterns:
 * - Debt markers (incomplete task markers and work-in-progress tags)
 * - AI-generation metadata
 * - Process/planning artifacts (Phase X, Sprint X, version stamps)
 *
 */
export const commentQuality = defineCheck({
  id: 'e54e576e-99ea-4beb-9f31-8971e0c852bc',
  slug: 'comment-quality',
  scope: { languages: ['typescript'], concerns: ['backend', 'frontend', 'cli'] },
  contentFilter: 'raw',

  confidence: 'medium',
  description: 'Detects banned comment patterns: debt markers, AI-metadata, and process artifacts',
  longDescription: `**Purpose:** Enforces comment quality standards by detecting banned comment patterns that reduce code quality or leak process metadata into source files.

**Detects:** Analyzes each file individually via regex matching against each line.
- Debt markers: \`// TODO\`, \`// FIXME\`, \`// HACK\`, \`// XXX\`, \`// OPTIMIZE\` (single-line and block comments)
- AI-generation metadata: comments containing "generated by AI/Claude/GPT/Copilot" or similar attribution patterns
- Process artifacts: \`// Phase N\`, \`// Sprint N\`, version stamps (\`// v1.2.3\`), date stamps (\`// Updated 2024-01-01\`), and "Added in vN" comments
- Excludes algorithm step comments like \`// Phase 1: Try primary operation\`

**Why it matters:** Debt markers indicate unfinished work, AI metadata is irrelevant to readers, and process artifacts become stale. All should be resolved or removed.

**Scope:** General best practice. Analyzes each file individually.`,
  tags: ['maintainability', 'code-quality', 'quality'],
  fileTypes: ['ts', 'tsx'],
  disabled: true,

  analyze(content: string, filePath: string): CheckViolation[] {
    // Quick filter: skip files without comment markers
    if (!content.includes('//') && !content.includes('/*')) {
      return []
    }

    const violations = analyzeFileContent(content)

    return violations.map((violation) => ({
      line: violation.line,
      message: `Banned comment pattern '${violation.type}' found. ${violation.fix}`,
      severity: 'error' as const,
      type: violation.type,
      suggestion: violation.fix,
      match: violation.comment.slice(0, 60),
      filePath,
    }))
  },
})
