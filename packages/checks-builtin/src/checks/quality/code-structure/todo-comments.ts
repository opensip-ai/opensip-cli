// @fitness-ignore-file batch-operation-limits -- iterates bounded collections (config entries, registry items, or small analysis results)
// @fitness-ignore-file toctou-race-condition -- TOCTOU acceptable in this non-concurrent context
/**
 * @fileoverview Technical Debt Comments Check
 *
 * Detects technical debt markers in comments for tracking and visibility.
 */

import { defineCheck, type CheckViolation } from '@opensip-tools/core'

// =============================================================================
// TYPES
// =============================================================================

/** Supported technical debt marker types */
enum TodoType {
  TODO = 'TODO',
  FIXME = 'FIXME',
  HACK = 'HACK',
  XXX = 'XXX',
  OPTIMIZE = 'OPTIMIZE',
}

// =============================================================================
// PRE-COMPILED REGEX PATTERNS
// =============================================================================

// Non-backtracking patterns for technical debt markers
// Using bounded quantifiers to prevent ReDoS vulnerabilities
const TODO_LINE_PATTERN = /\/\/\s{0,5}TODO[:\s]([^\n]{1,500})/i
const TODO_BLOCK_PATTERN = /\/\*\s{0,5}TODO[:\s]([^*]{1,500})\*\//i
const FIXME_LINE_PATTERN = /\/\/\s{0,5}FIXME[:\s]([^\n]{1,500})/i
const FIXME_BLOCK_PATTERN = /\/\*\s{0,5}FIXME[:\s]([^*]{1,500})\*\//i
const HACK_LINE_PATTERN = /\/\/\s{0,5}HACK[:\s]([^\n]{1,500})/i
const HACK_BLOCK_PATTERN = /\/\*\s{0,5}HACK[:\s]([^*]{1,500})\*\//i
const XXX_LINE_PATTERN = /\/\/\s{0,5}XXX[:\s]([^\n]{1,500})/i
const XXX_BLOCK_PATTERN = /\/\*\s{0,5}XXX[:\s]([^*]{1,500})\*\//i
const OPTIMIZE_LINE_PATTERN = /\/\/\s{0,5}OPTIMIZE[:\s]([^\n]{1,500})/i
const OPTIMIZE_BLOCK_PATTERN = /\/\*\s{0,5}OPTIMIZE[:\s]([^*]{1,500})\*\//i

interface PatternEntry {
  linePattern: RegExp
  blockPattern: RegExp
  type: TodoType
}

const PATTERNS: PatternEntry[] = [
  { linePattern: TODO_LINE_PATTERN, blockPattern: TODO_BLOCK_PATTERN, type: TodoType.TODO },
  { linePattern: FIXME_LINE_PATTERN, blockPattern: FIXME_BLOCK_PATTERN, type: TodoType.FIXME },
  { linePattern: HACK_LINE_PATTERN, blockPattern: HACK_BLOCK_PATTERN, type: TodoType.HACK },
  { linePattern: XXX_LINE_PATTERN, blockPattern: XXX_BLOCK_PATTERN, type: TodoType.XXX },
  {
    linePattern: OPTIMIZE_LINE_PATTERN,
    blockPattern: OPTIMIZE_BLOCK_PATTERN,
    type: TodoType.OPTIMIZE,
  },
]

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

function getSuggestionForType(type: TodoType): string {
  switch (type) {
    case TodoType.TODO:
      return 'Create a ticket to track this work and add the ticket ID to the comment, or complete the work now'
    case TodoType.FIXME:
      return 'Fix the issue described in this comment. If it requires significant work, create a ticket'
    case TodoType.HACK:
      return 'Replace this hack with a proper implementation. Document why the hack exists if it must remain'
    case TodoType.OPTIMIZE:
      return 'Profile the code to verify optimization is needed, then implement the optimization'
    case TodoType.XXX:
      return 'Address the technical debt described in this comment'
    default:
      return 'Review and address this comment'
  }
}

interface MatchResult {
  type: TodoType
  comment: string
}

function checkPatternEntry(line: string, entry: PatternEntry): MatchResult | null {
  // Try line pattern first
  const lineMatch = entry.linePattern.exec(line)
  if (lineMatch?.[1]) {
    return { type: entry.type, comment: lineMatch[1].trim() }
  }

  // Try block pattern
  const blockMatch = entry.blockPattern.exec(line)
  if (blockMatch?.[1]) {
    return { type: entry.type, comment: blockMatch[1].trim() }
  }

  return null
}

function matchLineForPatterns(line: string): MatchResult | null {
  for (const entry of PATTERNS) {
    const match = checkPatternEntry(line, entry)
    if (match) {
      return match
    }
  }
  return null
}

// =============================================================================
// CHECK DEFINITION
// =============================================================================

/**
 * Check: quality/todo-comments
 *
 * Detects technical debt markers (informational only).
 */
export const todoComments = defineCheck({
  id: 'cad70708-2de5-4094-97bc-6fa6f1f6217e',
  slug: 'todo-comments',
  scope: { languages: ['typescript'], concerns: ['backend', 'frontend', 'cli'] },
  contentFilter: 'raw',

  confidence: 'medium',
  description: 'Detects technical debt markers in comments',
  longDescription: `**Purpose:** Detects technical debt markers in comments for tracking and visibility, ensuring TODO/FIXME items are either resolved or converted into tracked tickets.

**Detects:** Analyzes each file individually via regex matching against each line.
- Single-line (\`//\`) and block (\`/* */\`) comment debt markers (technical-debt, fix-needed, hack, attention, and optimization prefixes)
- Regex pattern matches common debt-marker keywords followed by colon or whitespace
- Captures the comment text following each marker for context

**Why it matters:** Untracked debt markers accumulate silently. Surfacing them through the fitness framework ensures they become visible tickets with owners, preventing technical debt from being forgotten.

**Scope:** General best practice`,
  tags: ['quality', 'maintainability', 'code-quality'],
  fileTypes: ['ts'],
  // @fitness-ignore-next-line no-hardcoded-timeouts -- framework default for fitness check execution
  timeout: 180000, // 3 minutes - scans all production files

  analyze(content: string, filePath: string): CheckViolation[] {
    const violations: CheckViolation[] = []
    const lines = content.split('\n')

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? ''
      const matchResult = matchLineForPatterns(line)

      if (matchResult) {
        const { type, comment } = matchResult
        const suggestion = getSuggestionForType(type)

        violations.push({
          line: i + 1,
          message: `${type}: ${comment}`,
          severity: 'warning',
          suggestion,
          match: line.trim(),
          filePath,
        })
      }
    }

    return violations
  },
})
