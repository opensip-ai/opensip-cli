/**
 * @fileoverview Pino Serializer Coverage Check
 *
 * Validates that complex objects logged with Pino have serializers:
 * - Objects without registered serializers break structured logging
 * - Circular references cause logging failures
 * - Large objects need truncation
 */

import { defineCheck, type CheckViolation } from '@opensip-tools/fitness'

/**
 * Pre-compiled patterns for complex objects that need serializers.
 * These patterns are intentional and safe for static code analysis.
 * They detect object references in log statements, not user input.
 */
const REQUEST_PATTERN = new RegExp('\\breq\\s*[,}]')
const QUERY_RUNNER_PATTERN = new RegExp('queryRunner\\s*[,}]', 'i')
const ENTITY_PATTERN = new RegExp('\\bentity\\s*[,}]', 'i')

/**
 * Known complex objects that need serializers
 */
const COMPLEX_OBJECTS = [
  { pattern: REQUEST_PATTERN, name: 'Request' },
  { pattern: QUERY_RUNNER_PATTERN, name: 'QueryRunner' },
  { pattern: ENTITY_PATTERN, name: 'Entity' },
]

/**
 * Pre-compiled patterns for safe serialization indicators.
 * These patterns are intentional and safe for static code analysis.
 * Using escaped dot (\\.) instead of character class [.] per sonarjs/single-char-in-character-classes.
 */
const SAFE_ID_PATTERN = /\.id\s{0,10}[,}]/
const SAFE_NAME_PATTERN = /\.name\s{0,10}[,}]/
const SAFE_TO_STRING_PATTERN = /\.toString\s{0,10}\(\)/
const SAFE_JSON_STRINGIFY_PATTERN = /JSON\.stringify/
const SAFE_TO_JSON_PATTERN = /\.toJSON\s{0,10}\(\)/

/**
 * Safe patterns that indicate proper serialization
 */
const SAFE_PATTERNS = [
  SAFE_ID_PATTERN,
  SAFE_NAME_PATTERN,
  SAFE_TO_STRING_PATTERN,
  SAFE_JSON_STRINGIFY_PATTERN,
  SAFE_TO_JSON_PATTERN,
]

/**
 * Pre-compiled pattern for detecting logger calls with objects.
 * This pattern is intentional and safe for static code analysis.
 * Using bounded quantifiers for safety.
 */
const LOG_CALL_PATTERN = /logger\.(info|warn|error|debug|trace)\s{0,10}\(\s{0,10}\{/

/**
 * Pre-compiled pattern for detecting circular reference issues.
 * This pattern is intentional and safe for static code analysis.
 * Using bounded quantifiers for safety.
 */
const THIS_PATTERN = /:\s{0,10}this\s{0,10}[,}]/

/**
 * Counts brackets in a line
 * @param line - The line to count brackets in
 * @returns The net bracket count (open minus close)
 */
function countBrackets(line: string): number {
  let openCount = 0
  let closeCount = 0
  for (const char of line) {
    if (char === '{') openCount++
    if (char === '}') closeCount++
  }
  return openCount - closeCount
}

/**
 * Builds the complete log statement from multiple lines
 * @param lines - All lines in the file
 * @param startIndex - Starting line index
 * @returns The complete log statement
 */
function buildLogStatement(lines: string[], startIndex: number): string {
  const firstLine = lines[startIndex]
  if (!firstLine) return ''

  let logStatement = firstLine
  let bracketCount = countBrackets(firstLine)
  let j = startIndex + 1

  while (bracketCount > 0 && j < lines.length) {
    const nextLine = lines[j]
    if (nextLine) {
      logStatement += '\n' + nextLine
      bracketCount += countBrackets(nextLine)
    }
    j++
  }

  return logStatement
}

interface ViolationInfo {
  lineNum: number
  message: string
  suggestion: string
  match: string
}

/**
 * Creates complex object violation info
 */
function createComplexObjectViolation(
  lineNum: number,
  objectName: string,
  match: string,
): ViolationInfo {
  const lowerName = objectName.toLowerCase()
  return {
    lineNum,
    message: `Logging ${objectName} object without serializer`,
    suggestion: `Register a Pino serializer for ${objectName} objects, or extract specific fields: { ${lowerName}Id: ${lowerName}.id, ${lowerName}Name: ${lowerName}.name }`,
    match,
  }
}

/**
 * Creates circular reference violation info
 */
function createCircularReferenceViolation(lineNum: number, match: string): ViolationInfo {
  return {
    lineNum,
    message: 'Logging "this" directly may cause circular reference',
    suggestion:
      'Extract specific properties from "this" instead of logging the entire object: { className: this.constructor.name, id: this.id }',
    match,
  }
}

/**
 * Checks for complex object violations in log statement
 */
function checkComplexObjects(
  logStatement: string,
  lineNum: number,
  match: string,
  violationInfos: ViolationInfo[],
): void {
  for (const { pattern, name } of COMPLEX_OBJECTS) {
    if (pattern.test(logStatement)) {
      violationInfos.push(createComplexObjectViolation(lineNum, name, match))
    }
  }
}

/**
 * Checks for circular reference violations in log statement
 */
function checkCircularReferences(
  logStatement: string,
  lineNum: number,
  match: string,
  violationInfos: ViolationInfo[],
): void {
  if (THIS_PATTERN.test(logStatement)) {
    violationInfos.push(createCircularReferenceViolation(lineNum, match))
  }
}

/**
 * Analyze a file for Pino serializer coverage issues
 */
function analyzeFile(content: string, _filePath: string): CheckViolation[] {
  const violations: CheckViolation[] = []

  // Quick filter: skip files without logger patterns
  if (
    !content.includes('logger.info') &&
    !content.includes('logger.warn') &&
    !content.includes('logger.error') &&
    !content.includes('logger.debug')
  ) {
    return violations
  }

  const lines = content.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line) continue

    // Check for logger calls with objects
    if (!LOG_CALL_PATTERN.test(line)) continue

    // Get the full log statement (may span multiple lines)
    const logStatement = buildLogStatement(lines, i)

    // Check if any safe patterns are used
    const isSafe = SAFE_PATTERNS.some((p) => p.test(logStatement))
    if (isSafe) continue

    const lineNum = i + 1
    const violationInfos: ViolationInfo[] = []

    checkComplexObjects(logStatement, lineNum, line, violationInfos)
    checkCircularReferences(logStatement, lineNum, line, violationInfos)

    for (const info of violationInfos) {
      violations.push({
        line: info.lineNum,
        column: 0,
        message: info.message,
        severity: 'warning',
        suggestion: info.suggestion,
        match: info.match,
      })
    }
  }

  return violations
}

/**
 * Check: quality/pino-serializer-coverage
 *
 * Validates that complex objects logged have proper Pino serializers.
 */
export const pinoSerializerCoverage = defineCheck({
  id: 'e54a6ff0-332e-4848-bc62-d7df37b4795a',
  slug: 'pino-serializer-coverage',
  scope: { languages: ['typescript'], concerns: ['backend', 'server'] },
  contentFilter: 'raw',

  confidence: 'medium',
  description: 'Validates that complex objects logged have proper Pino serializers',
  longDescription: `**Purpose:** Validates that complex objects passed to Pino logger calls have proper serializers registered, preventing structured logging failures from circular references or oversized objects.

**Detects:**
- \`logger.(info|warn|error|debug|trace)\` calls containing complex object references: \`req\` (Request), \`queryRunner\` (QueryRunner), \`entity\` (Entity) without safe serialization
- Logging \`this\` directly (matched via \`:\\s*this\\s*[,}]\`), which risks circular reference errors
- Skips log statements that use safe patterns: \`.id\`, \`.name\`, \`.toString()\`, \`JSON.stringify\`, or \`.toJSON()\`

**Why it matters:** Logging unserialized complex objects causes Pino to fail silently, produce truncated output, or throw circular reference errors -- all of which degrade observability in production.

**Scope:** General best practice. Analyzes each file individually using regex-based log statement scanning.`,
  tags: ['logging', 'quality'],
  fileTypes: ['ts'],
  // @fitness-ignore-next-line no-hardcoded-timeouts -- framework default for fitness check execution
  timeout: 180000, // 3 minutes - scans log statements across codebase

  analyze: analyzeFile,
})
