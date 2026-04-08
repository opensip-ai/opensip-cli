/**
 * @fileoverview God function detection check
 * @module checks-builtin/checks/quality/code-structure/god-function-detection
 *
 * Detects functions that do too many things by measuring cyclomatic complexity
 * (branching paths) and concern spread (distinct module references). These are
 * signals that a function should be decomposed into smaller, focused units.
 *
 * Complements existing checks:
 * - file-length-limits: measures function line count
 * - clean-code-function-parameters: measures parameter count
 * - This check: measures complexity and concern spread
 *
 * Thresholds:
 * - Cyclomatic complexity: warning > 10, error > 20
 * - Concern spread (distinct module refs): warning > 5, error > 8
 */

import { defineCheck, type CheckViolation } from '@opensip-tools/core'

// =============================================================================
// THRESHOLDS
// =============================================================================

const COMPLEXITY_THRESHOLDS = {
  warning: 10,
  error: 20,
} as const

const CONCERN_SPREAD_THRESHOLDS = {
  warning: 5,
  error: 8,
} as const

// =============================================================================
// FUNCTION EXTRACTION (regex-based, same approach as file-length-limits)
// =============================================================================

const FUNCTION_KEYWORD_PATTERN = /^\s{0,50}(?:async\s{1,10})?function\s{1,10}(\w{1,100})/
const CONST_ARROW_PATTERN =
  /^\s{0,50}(?:export\s{1,10})?(?:const|let)\s{1,10}(\w{1,100})\s{0,10}=\s{0,10}(?:async\s{1,10})?\(/
const CONST_FUNCTION_PATTERN =
  /^\s{0,50}(?:export\s{1,10})?(?:const|let)\s{1,10}(\w{1,100})\s{0,10}=\s{0,10}(?:async\s{1,10})?function/
const CLASS_METHOD_PATTERN =
  /^\s{0,50}(?:public|private|protected)?\s{0,10}(?:static\s{1,10})?(?:async\s{1,10})?(\w{1,100})\s{0,10}\([^)]{0,500}\)\s{0,10}(?::\s{0,10}[^{]{0,200})?\s{0,10}\{$/

const FUNCTION_PATTERNS = [
  FUNCTION_KEYWORD_PATTERN,
  CONST_ARROW_PATTERN,
  CONST_FUNCTION_PATTERN,
  CLASS_METHOD_PATTERN,
]

// Branching constructs that increase cyclomatic complexity
const BRANCH_PATTERNS = [
  /\bif\s*\(/,
  /\belse\s+if\s*\(/,
  /\belse\s*\{/,
  /\bcase\s+/,
  /\bfor\s*\(/,
  /\bwhile\s*\(/,
  /\bdo\s*\{/,
  /\bcatch\s*\(/,
  /\?\?/,
  /\?\./,
  /\?[^?.:]/,  // ternary (not ??, not ?.)
  /&&(?!=)/,   // logical AND (not &&=)
  /\|\|(?!=)/, // logical OR (not ||=)
]

// Module/concern reference patterns — detect when a function reaches into many domains
const CONCERN_PATTERNS = [
  /\b(?:db|database|getDatabase)\b/i,
  /\blogger\b/,
  /\b(?:readFile|writeFile|existsSync|mkdirSync|fs)\b/,
  /\b(?:reply\.status|reply\.send|reply\.header)\b/,
  /\b(?:schema\.|eq\(|and\(|or\(|desc\(|asc\()\b/,   // drizzle ORM
  /\b(?:span\.|tracer\.|trace\.)\b/,                   // OTel
  /\b(?:JSON\.parse|JSON\.stringify)\b/,
  /\b(?:setTimeout|setInterval|clearTimeout|clearInterval)\b/,
]

// =============================================================================
// ANALYSIS
// =============================================================================

interface FunctionBounds {
  name: string
  startLine: number
  body: string[]
}

function matchFunctionName(line: string): string | null {
  for (const pattern of FUNCTION_PATTERNS) {
    const match = pattern.exec(line)
    if (match?.[1]) return match[1]
  }
  return null
}

function extractFunctionBodies(content: string): FunctionBounds[] {
  const lines = content.split('\n')
  const functions: FunctionBounds[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line) continue

    // Skip comments
    const trimmed = line.trim()
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue

    const name = matchFunctionName(line)
    if (!name) continue

    // Extract function body by tracking brace depth (skip braces in strings/comments)
    const body: string[] = []
    let depth = 0
    let started = false
    const maxEnd = Math.min(i + 500, lines.length)

    for (let j = i; j < maxEnd; j++) {
      const bodyLine = lines[j]
      if (!bodyLine) continue

      let inString: string | null = null
      let escaped = false
      for (const char of bodyLine) {
        if (escaped) { escaped = false; continue }
        if (char === '\\') { escaped = true; continue }
        if (inString) {
          if (char === inString) inString = null
          continue
        }
        if (char === "'" || char === '"' || char === '`') { inString = char; continue }
        if (char === '{') { depth++; started = true }
        if (char === '}') depth--
      }

      body.push(bodyLine)

      if (started && depth === 0) break
    }

    if (body.length > 0) {
      functions.push({ name, startLine: i + 1, body })
    }
  }

  return functions
}

function isCommentLine(line: string): boolean {
  const trimmed = line.trim()
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')
}

function computeComplexity(body: string[]): number {
  let complexity = 1 // base path

  for (const line of body) {
    if (isCommentLine(line)) continue

    for (const pattern of BRANCH_PATTERNS) {
      if (pattern.test(line)) complexity++
    }
  }

  return complexity
}

function computeConcernSpread(body: string[]): number {
  const concerns = new Set<number>()

  for (const line of body) {
    if (isCommentLine(line)) continue

    for (let idx = 0; idx < CONCERN_PATTERNS.length; idx++) {
      if (CONCERN_PATTERNS[idx].test(line)) {
        concerns.add(idx)
      }
    }
  }

  return concerns.size
}

// Functions that are inherently complex and should be excluded
function isExemptFunction(name: string, filePath: string): boolean {
  // Composition roots / factory functions
  if (name === 'buildAppInjector' || name === 'buildInjector') return true
  if (name === 'registerRoutes' || name === 'registerPlugins') return true
  // State machine definitions
  if (name === 'createMachine' || name === 'setup') return true
  // Migration files
  if (filePath.includes('/migrations/')) return true
  return false
}

// =============================================================================
// CHECK DEFINITION
// =============================================================================

export const godFunctionDetection = defineCheck({
  id: 'b2e4f8a1-3c7d-4e9f-a1b2-8d5e6f7a9c0d',
  slug: 'god-function-detection',
  scope: { languages: ['typescript'], concerns: ['backend', 'frontend', 'cli'] },
  confidence: 'medium',
  description:
    'Detects functions with excessive cyclomatic complexity or concern spread (god functions)',
  longDescription: `**Purpose:** Identifies functions that do too many things — high branching complexity or touching too many distinct concerns (database, HTTP, filesystem, etc.).

**Detects:**
- Cyclomatic complexity > 10 (warning) or > 20 (error): too many branching paths (if/else/switch/ternary/logical operators)
- Concern spread > 5 (warning) or > 8 (error): function touches too many distinct domains (database + HTTP + filesystem + tracing = 4 concerns)

**Complements:**
- \`file-length-limits\`: measures raw line count per function
- \`clean-code-function-parameters\`: measures parameter count
- This check: measures branching complexity and domain coupling

**Why it matters:** God functions are hard to test (too many paths), hard to understand (too many concerns), and hard to change safely (wide blast radius). Splitting them improves testability, readability, and maintainability.

**Excluded:** Composition root functions (buildAppInjector), route registration, state machine definitions, migration files.`,
  tags: ['maintainability', 'complexity', 'testability', 'quality'],
  fileTypes: ['ts', 'tsx'],

  analyze(content: string, filePath: string): CheckViolation[] {
    // Skip test files — test functions are often complex by nature
    if (filePath.includes('.test.') || filePath.includes('__tests__')) return []

    const violations: CheckViolation[] = []
    const functions = extractFunctionBodies(content)

    for (const func of functions) {
      if (isExemptFunction(func.name, filePath)) continue

      const complexity = computeComplexity(func.body)
      const concernSpread = computeConcernSpread(func.body)

      // Check cyclomatic complexity
      if (complexity >= COMPLEXITY_THRESHOLDS.error) {
        violations.push({
          line: func.startLine,
          message: `Function '${func.name}' has cyclomatic complexity ${complexity} (limit: ${COMPLEXITY_THRESHOLDS.error}). Too many branching paths — extract helper functions.`,
          severity: 'error',
          suggestion: `Split '${func.name}' into smaller functions. Extract each branch into a named helper that describes the decision being made.`,
          type: 'GOD_FUNCTION_COMPLEXITY',
          match: func.name,
          filePath,
        })
      } else if (complexity >= COMPLEXITY_THRESHOLDS.warning) {
        violations.push({
          line: func.startLine,
          message: `Function '${func.name}' has cyclomatic complexity ${complexity} (limit: ${COMPLEXITY_THRESHOLDS.warning}). Consider simplifying.`,
          severity: 'warning',
          suggestion: `Review '${func.name}' for opportunities to extract helper functions or use early returns to reduce nesting.`,
          type: 'GOD_FUNCTION_COMPLEXITY',
          match: func.name,
          filePath,
        })
      }

      // Check concern spread
      if (concernSpread >= CONCERN_SPREAD_THRESHOLDS.error) {
        violations.push({
          line: func.startLine,
          message: `Function '${func.name}' touches ${concernSpread} distinct concerns (limit: ${CONCERN_SPREAD_THRESHOLDS.error}). Doing too many things — extract domain-specific helpers.`,
          severity: 'error',
          suggestion: `Split '${func.name}' so each function deals with one concern. Extract database logic, HTTP responses, and side effects into separate functions.`,
          type: 'GOD_FUNCTION_CONCERNS',
          match: func.name,
          filePath,
        })
      } else if (concernSpread >= CONCERN_SPREAD_THRESHOLDS.warning) {
        violations.push({
          line: func.startLine,
          message: `Function '${func.name}' touches ${concernSpread} distinct concerns (limit: ${CONCERN_SPREAD_THRESHOLDS.warning}). Consider separating responsibilities.`,
          severity: 'warning',
          suggestion: `Review '${func.name}' for mixed concerns. Functions that touch database, HTTP, filesystem, and logging are candidates for decomposition.`,
          type: 'GOD_FUNCTION_CONCERNS',
          match: func.name,
          filePath,
        })
      }
    }

    return violations
  },
})
