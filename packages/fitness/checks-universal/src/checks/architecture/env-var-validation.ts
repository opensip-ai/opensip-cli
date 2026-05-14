// @fitness-ignore-file semgrep-scan -- non-literal RegExp patterns use envVarName extracted from process.env.\w+ regex match on source code, not user input; regex operates on bounded, trusted codebase files
/**
 * @fileoverview Environment Variable Validation check (v2)
 */

import { defineCheck, type CheckViolation } from '@opensip-tools/fitness'

import { createPathMatcher } from '../../utils/index.js'


// =============================================================================
// TYPES
// =============================================================================

type IssueType =
  | 'unvalidated-access'
  | 'missing-default'
  | 'type-coercion'
  | 'direct-access-outside-config'

interface EnvVarIssue {
  file: string
  line: number
  type: IssueType
  message: string
  suggestion: string
  severity: 'error' | 'warning'
  envVarName?: string | undefined
}

// =============================================================================
// PRE-COMPILED REGEX PATTERNS
// =============================================================================

// Excluded path patterns
const TEST_FILE_PATTERN = /\.test\.[jt]s$/
const SPEC_FILE_PATTERN = /\.spec\.[jt]s$/
const TESTS_DIR_PATTERN = /__tests__\//
const BENCH_FILE_PATTERN = /\.bench\.[jt]s$/
const CONFIG_DIR_PATTERN = /config\//
const CONFIG_FILE_PATTERN = /\.config\.[jt]s$/

// Safe access patterns
const NULLISH_COALESCING_PATTERN = /process\.env\.\w+\s*\?\?/
const LOGICAL_OR_PATTERN = /process\.env\.\w+\s*\|\|/
const NON_NULL_ASSERTION_PATTERN = /process\.env\.\w+\s*!\s*[,;)]/
const GET_ENV_PATTERN = /getEnv\s*\(/
const CONFIG_ACCESS_PATTERN = /config\.\w+/
const ENV_ACCESS_PATTERN = /env\.\w+/
const REQUIRE_ENV_PATTERN = /requireEnv\s*\(/
const OPTIONAL_ENV_PATTERN = /optionalEnv\s*\(/

// Env var extraction pattern
const ENV_VAR_PATTERN = /process\.env\.(\w+)/g

const NON_RUNTIME_PATTERNS = [
  TEST_FILE_PATTERN,
  SPEC_FILE_PATTERN,
  TESTS_DIR_PATTERN,
  BENCH_FILE_PATTERN,
  CONFIG_DIR_PATTERN,
  CONFIG_FILE_PATTERN,
]

const SAFE_PATTERNS = [
  NULLISH_COALESCING_PATTERN,
  LOGICAL_OR_PATTERN,
  NON_NULL_ASSERTION_PATTERN,
  GET_ENV_PATTERN,
  CONFIG_ACCESS_PATTERN,
  ENV_ACCESS_PATTERN,
  REQUIRE_ENV_PATTERN,
  OPTIONAL_ENV_PATTERN,
]

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

const isExcludedEnvPath = createPathMatcher(NON_RUNTIME_PATTERNS)

function isSafeContext(context: string): boolean {
  return SAFE_PATTERNS.some((p) => p.test(context))
}

function hasNullCheck(context: string): boolean {
  return context.includes('??') || context.includes('||') || context.includes('?')
}

function getMatchContext(line: string, matchIndex: number, matchLength: number): string {
  const start = Math.max(0, matchIndex - 20)
  const end = Math.min(line.length, matchIndex + matchLength + 50)
  return line.slice(start, end)
}

/**
 * Check for type coercion issues using dynamic patterns
 */
function hasTypeCoercionIssue(context: string, envVarName: string): boolean {
  const numericOpPattern = new RegExp(String.raw`process\.env\.${envVarName}\s*[+\-*/<>]=?\s*\d`)
  const reverseOpPattern = new RegExp(String.raw`\d\s*[+\-*/<>]=?\s*process\.env\.${envVarName}`)
  const portPattern = `port`
  const timeoutPattern = `timeout`
  const envAccess = `process.env.${envVarName}`

  if (numericOpPattern.test(context) || reverseOpPattern.test(context)) {
    return true
  }

  // Check for port/timeout without parseInt
  if (
    (context.toLowerCase().includes(portPattern) ||
      context.toLowerCase().includes(timeoutPattern)) &&
    context.includes(envAccess) &&
    !context.includes('parseInt')
  ) {
    return true
  }

  return false
}

// =============================================================================
// ISSUE DETECTION
// =============================================================================

interface MatchAnalysis {
  envVarName: string
  context: string
  matchIndex: number
}

function analyzeMatch(line: string, match: RegExpMatchArray): MatchAnalysis | null {
  const envVarName = match[1]
  if (!envVarName) {
    return null
  }

  const matchIndex = match.index ?? 0
  const context = getMatchContext(line, matchIndex, match[0].length)

  return { envVarName, context, matchIndex }
}

function createIssue(
  filePath: string,
  lineNumber: number,
  type: IssueType,
  envVarName: string,
): EnvVarIssue {
  switch (type) {
    case 'direct-access-outside-config': {
      return {
        file: filePath,
        line: lineNumber,
        type,
        message: `Direct process.env.${envVarName} access outside config module`,
        suggestion: 'Access environment variables through config module instead',
        severity: 'warning',
        envVarName,
      }
    }
    case 'type-coercion': {
      return {
        file: filePath,
        line: lineNumber,
        type,
        message: `process.env.${envVarName} used without type conversion`,
        suggestion: 'Parse env var: parseInt(process.env.X, 10) or Boolean(process.env.X)',
        severity: 'warning',
        envVarName,
      }
    }
    case 'unvalidated-access': {
      return {
        file: filePath,
        line: lineNumber,
        type,
        message: `process.env.${envVarName} accessed without null check`,
        suggestion: 'Add default: process.env.X ?? "default" or validate with requireEnv()',
        severity: 'warning',
        envVarName,
      }
    }
    default: {
      return {
        file: filePath,
        line: lineNumber,
        type,
        message: `Issue with process.env.${envVarName}`,
        suggestion: 'Validate environment variable access',
        severity: 'warning',
        envVarName,
      }
    }
  }
}

function analyzeMatchForIssues(
  analysis: MatchAnalysis,
  filePath: string,
  lineNumber: number,
  isConfigFile: boolean,
): EnvVarIssue | null {
  const { envVarName, context } = analysis

  // Skip if in safe context
  if (isSafeContext(context)) {
    return null
  }

  // Check for direct access outside config
  if (!isConfigFile) {
    return createIssue(filePath, lineNumber, 'direct-access-outside-config', envVarName)
  }

  // Check for type coercion issues
  if (hasTypeCoercionIssue(context, envVarName)) {
    return createIssue(filePath, lineNumber, 'type-coercion', envVarName)
  }

  // Check for missing null check
  if (!hasNullCheck(context)) {
    return createIssue(filePath, lineNumber, 'unvalidated-access', envVarName)
  }

  return null
}

function processLine(
  line: string,
  lineIndex: number,
  filePath: string,
  isConfigFile: boolean,
): EnvVarIssue[] {
  const issues: EnvVarIssue[] = []

  // Reset regex lastIndex for global patterns
  ENV_VAR_PATTERN.lastIndex = 0
  const matches = line.matchAll(ENV_VAR_PATTERN)

  for (const match of matches) {
    const analysis = analyzeMatch(line, match)
    if (!analysis) {
      continue
    }

    const issue = analyzeMatchForIssues(analysis, filePath, lineIndex + 1, isConfigFile)
    if (issue) {
      issues.push(issue)
    }
  }

  return issues
}

function analyzeFile(filePath: string, content: string): EnvVarIssue[] {
  if (isExcludedEnvPath(filePath)) {
    return []
  }

  const lines = content.split('\n')
  const isConfigFile = filePath.includes('config')
  const issues: EnvVarIssue[] = []

  for (const [i, line] of lines.entries()) {
    if (!line) {
      continue
    }

    const lineIssues = processLine(line, i, filePath, isConfigFile)
    issues.push(...lineIssues)
  }

  return issues
}

// =============================================================================
// CHECK DEFINITION
// =============================================================================

/**
 * Check: architecture/env-var-validation
 *
 * Detects environment variable access without validation:
 * - process.env.X without null check
 * - Missing default values
 * - Type coercion issues
 * - Direct access outside config modules
 */
export const envVarValidation = defineCheck({
  id: '47d3e7c7-7dc0-4fd7-bcd6-950837e091df',
  slug: 'env-var-validation',
  scope: { languages: ['typescript'], concerns: ['backend', 'server'] },
  contentFilter: 'raw',

  confidence: 'medium',
  description: 'Detects environment variable access without proper validation',
  longDescription: `**Purpose:** Enforces safe environment variable access by detecting unvalidated \`process.env\` usage outside config modules.

**Detects:**
- \`process.env.X\` access without null check (\`??\`, \`||\`, or \`?\`)
- \`process.env.X\` used in numeric operations without \`parseInt()\` (type coercion)
- Direct \`process.env.X\` access outside config modules (should use \`getEnv()\`, \`requireEnv()\`, or config objects)
- Recognizes safe patterns: \`??\`, \`||\`, \`getEnv()\`, \`requireEnv()\`, \`optionalEnv()\`, \`config.*\`

**Why it matters:** Unvalidated env var access causes silent \`undefined\` values and type coercion bugs that surface only at runtime.

**Scope:** General best practice. Analyzes each file individually.`,
  tags: ['architecture', 'best-practices'],
  fileTypes: ['ts'],

  analyze(content: string, filePath: string): CheckViolation[] {
    // Skip files without process.env
    if (!content.includes('process.env')) {
      return []
    }

    const issues = analyzeFile(filePath, content)

    return issues.map((issue) => ({
      line: issue.line,
      message: `${issue.message}. ${issue.suggestion}`,
      severity: issue.severity,
      suggestion: issue.suggestion,
      match: `process.env.${issue.envVarName ?? ''}`,
      type: issue.type,
    }))
  },
})
