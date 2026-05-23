/**
 * @fileoverview Process/planning artifact detection in comments.
 *
 * Detects "Phase 1", "Sprint 12", version stamps, and date stamps
 * left in comments. These belong in the backlog, the changelog, or
 * git history — not the source.
 *
 * Extracted from the former `comment-quality` umbrella in Phase C1.
 */

import { defineCheck, type CheckViolation } from '@opensip-tools/fitness'

/** Maximum line length for regex matching */
const MAX_LINE_LENGTH = 500

/**
 * Safely truncate a line for regex matching.
 */
function safeLineForRegex(line: string): string {
  return line.length > MAX_LINE_LENGTH ? line.slice(0, MAX_LINE_LENGTH) : line
}

interface PatternDef {
  regex: RegExp
  fix: string
}

// Process/planning artifact patterns (bounded quantifiers)
const PHASE_PATTERN = /\/\/\s{0,5}Phase\s{1,5}\d{1,3}\s{0,5}(?:Enhancement|Implementation|:|$)/i
const SPRINT_PATTERN = /\/\/\s{0,5}Sprint\s{1,5}\d{1,5}\b/i
const VERSION_STAMP_PATTERN = /\/\/\s{0,5}v\d{1,3}\.\d{1,3}(?:\.\d{1,5})?\s{0,5}$/i
const ADDED_IN_VERSION_PATTERN = /\/\/\s{0,5}Added\s{1,5}in\s{1,5}v\d{1,5}\b/i
const DATE_STAMP_PATTERN = /\/\/\s{0,5}Updated?\s{1,5}\d{4}-\d{2}-\d{2}\b/i

// Exclusion pattern for algorithm step comments
const ALGORITHM_PHASE_PATTERN = /\/\/\s{0,5}Phase\s{1,5}\d{1,3}\s{0,5}:\s{0,5}\w{1,50}/i

const PATTERNS: PatternDef[] = [
  {
    regex: PHASE_PATTERN,
    fix: 'Remove planning artifact; use backlog for tracking future work',
  },
  {
    regex: SPRINT_PATTERN,
    fix: 'Remove planning artifact; sprint references are not useful to code readers',
  },
  {
    regex: VERSION_STAMP_PATTERN,
    fix: 'Remove version stamp; git history tracks this information',
  },
  {
    regex: ADDED_IN_VERSION_PATTERN,
    fix: 'Remove version stamp; git history tracks this information',
  },
  {
    regex: DATE_STAMP_PATTERN,
    fix: 'Remove date stamp; git history tracks this information',
  },
]

const EXCLUDE_PATTERNS: RegExp[] = [
  // Algorithm step comments like "Phase 1: Try primary operation" are allowed
  ALGORITHM_PHASE_PATTERN,
]

/**
 * Check: quality/no-process-artifacts
 *
 * Detects process/planning artifacts (Phase X, Sprint X, version
 * stamps, date stamps) in comments.
 */
export const noProcessArtifacts = defineCheck({
  id: '7c4d8e9f-2b3a-4d5e-89c1-2f3e4d5c6b7a',
  slug: 'no-process-artifacts',
  scope: { languages: ['typescript'], concerns: ['backend', 'frontend', 'cli'] },
  contentFilter: 'raw',
  confidence: 'medium',
  description: 'Detects process/planning artifacts (Phase X, Sprint X, version stamps) in comments',
  longDescription: `**Purpose:** Process/planning artifacts in source code become stale and clutter file history. Tracking belongs in the backlog, changelogs, or git history.

**Detects:**
- \`// Phase N\` (excluding algorithm step comments like \`// Phase 1: Try primary operation\`)
- \`// Sprint N\`
- Version stamps (\`// v1.2.3\`)
- "Added in vN" comments
- Date stamps (\`// Updated 2024-01-01\`)

**Why it matters:** When the planning context shifts, these comments become misleading. Trim them at authorship time and rely on the backlog and version control for the real history.`,
  tags: ['maintainability', 'code-quality', 'quality'],
  fileTypes: ['ts', 'tsx'],
  disabled: true,

  analyze(content: string, filePath: string): CheckViolation[] {
    if (!content.includes('//')) {
      return []
    }

    const violations: CheckViolation[] = []
    const lines = content.split('\n')

    for (const [i, line] of lines.entries()) {
      if (!line) continue
      const safeLine = safeLineForRegex(line)

      const isExcluded = EXCLUDE_PATTERNS.some((pattern) => pattern.test(safeLine))
      if (isExcluded) continue

      for (const { regex, fix } of PATTERNS) {
        if (regex.test(safeLine)) {
          violations.push({
            line: i + 1,
            message: `Process artifact comment found. ${fix}`,
            severity: 'error',
            suggestion: fix,
            match: safeLine.trim().slice(0, 60),
            filePath,
          })
          break // one finding per line
        }
      }
    }

    return violations
  },
})
