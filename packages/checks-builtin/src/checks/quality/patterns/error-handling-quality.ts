// @fitness-ignore-file canonical-result-usage -- References Result pattern in comments/JSDoc for pattern detection documentation, not actual Result usage
// @fitness-ignore-file clean-code-function-parameters -- AST visitor helper functions require node, sourceFile, file, filePath, builder, checkId params for TypeScript analysis
// @fitness-ignore-file logging-standards -- String literals in suggestion text reference logger calls, not actual logger usage
// @fitness-ignore-file error-handling-quality -- Fitness check implementation: catch blocks in AST analysis intentionally return empty results to skip unreadable files
/**
 * @fileoverview Unified Error Handling Quality Check
 *
 * Detects silent error handling in both try/catch and Result patterns.
 * Replaces: resilience/no-empty-catch, quality/error-swallowing-boolean
 */

import * as ts from 'typescript'

import { defineCheck, type CheckViolation } from '@opensip-tools/core'
import { getSharedSourceFile } from '@opensip-tools/core/framework/parse-cache.js'
import { isTestFile } from '../../../utils/index.js'

// =============================================================================
// WHITELIST PATTERNS
// =============================================================================

/**
 * Patterns that indicate proper error handling (logging)
 */
const LOGGING_PATTERNS = [
  /logger\.(error|warn|debug|info)\s*\(/,
  /safeLogger\.(error|warn|debug|info)\s*\(/,
  /console\.(error|warn)\s*\(/,
  /\.log\s*\(/,
  /unwrapOrLog\s*\(/,
  /matchLog\s*\(/,
  /handleErr\s*\(/,
]

/**
 * Patterns that indicate intentional silent handling
 */
const MARKER_PATTERNS = [
  /@swallow-ok/,
  /@handles/,
  /\/\/\s*intentionally/i,
  /\/\/\s*expected/i,
  /graceful/i,
]

/**
 * Patterns that indicate error propagation
 */
const PROPAGATION_PATTERNS = [
  /\berr\s*\(/,
  /Result\.err\s*\(/,
  /new\s+Failure\s*\(/,
  /return\s+\S[^\n]*\.error\b/,
]

/**
 * Pattern for rethrow
 */
const RETHROW_PATTERN = /\bthrow\b/

/**
 * Sentinel return values that indicate silent error handling
 */
const SENTINEL_VALUES = ['false', 'null', 'undefined', '[]', '{}']

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Check if text contains acceptable error handling
 * @param text - Text to check
 * @returns True if acceptable pattern found
 */
function hasAcceptablePattern(text: string): boolean {
  if (LOGGING_PATTERNS.some((p) => p.test(text))) return true
  if (MARKER_PATTERNS.some((p) => p.test(text))) return true
  if (PROPAGATION_PATTERNS.some((p) => p.test(text))) return true
  if (RETHROW_PATTERN.test(text)) return true
  return false
}

/**
 * Get return value type from expression
 * @param expr - TypeScript expression
 * @param sourceFile - Source file for getting text
 * @returns String representation or null if not a sentinel
 */
function getReturnValue(expr: ts.Expression | undefined, sourceFile: ts.SourceFile): string | null {
  if (!expr) return 'undefined'
  if (expr.kind === ts.SyntaxKind.FalseKeyword) return 'false'
  if (expr.kind === ts.SyntaxKind.NullKeyword) return 'null'
  if (ts.isIdentifier(expr) && expr.getText(sourceFile) === 'undefined') return 'undefined'
  if (ts.isArrayLiteralExpression(expr) && expr.elements.length === 0) return '[]'
  if (ts.isObjectLiteralExpression(expr) && expr.properties.length === 0) return '{}'
  return null
}

// =============================================================================
// CHECK FUNCTIONS
// =============================================================================

/**
 * Check a catch clause for violations
 */
function checkCatchClause(node: ts.CatchClause, sourceFile: ts.SourceFile): CheckViolation[] {
  const violations: CheckViolation[] = []
  const catchText = node.block.getText(sourceFile)

  // Skip if has acceptable pattern
  if (hasAcceptablePattern(catchText)) return violations

  const trimmed = catchText.replace(/\{|\}/g, '').trim()

  // Empty catch - SEVERITY: ERROR
  if (trimmed === '' || /^\/[/*]/.test(trimmed)) {
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart())
    violations.push({
      line: line + 1,
      column: 0,
      message: 'Empty catch block silently swallows errors',
      severity: 'error',
      suggestion:

        "Add logging: `logger.error({ evt: 'operation.failed', err })` or add `// @swallow-ok reason`",
      match: 'catch',
    })
    return violations
  }

  // Check for sentinel returns without logging
  const visitReturn = (n: ts.Node): void => {
    if (ts.isReturnStatement(n)) {
      const val = getReturnValue(n.expression, sourceFile)
      if (val && SENTINEL_VALUES.includes(val)) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(n.getStart())
        violations.push({
          line: line + 1,
          column: 0,
          message: `Catch returns ${val} without logging`,
          severity: 'error',
  
          suggestion: `Add logging before return: \`logger.warn({ evt: 'operation.failed', err })\``,
          match: `return ${val}`,
        })
      }
    }
    ts.forEachChild(n, visitReturn)
  }
  visitReturn(node.block)

  return violations
}

/**
 * Check Result.isErr() usage for violations
 */
function checkResultIsErr(node: ts.IfStatement, sourceFile: ts.SourceFile): CheckViolation[] {
  const violations: CheckViolation[] = []
  const cond = node.expression.getText(sourceFile)
  // @fitness-ignore-next-line error-handling-quality -- String literal check for '.isErr()', not actual Result error handling
  if (!cond.includes('.isErr()')) return violations

  const thenText = node.thenStatement.getText(sourceFile)
  if (hasAcceptablePattern(thenText)) return violations

  // Check for silent sentinel returns
  const visitReturn = (n: ts.Node): void => {
    if (ts.isReturnStatement(n)) {
      const val = getReturnValue(n.expression, sourceFile)
      if (val && SENTINEL_VALUES.includes(val)) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart())
        violations.push({
          line: line + 1,
          column: 0,
          message: `Result error silently discarded - returns ${val}`,
          severity: 'error',
          suggestion: `Use: \`result.unwrapOrLog(${val}, { evt: 'operation.failed' })\``,
          match: 'isErr()',
        })
      }
    }
  }

  if (ts.isBlock(node.thenStatement)) {
    node.thenStatement.statements.forEach(visitReturn)
  } else {
    visitReturn(node.thenStatement)
  }

  return violations
}

/**
 * Check Result methods for violations
 */
function checkResultMethods(node: ts.CallExpression, sourceFile: ts.SourceFile): CheckViolation[] {
  const violations: CheckViolation[] = []

  if (!ts.isPropertyAccessExpression(node.expression)) return violations

  const method = node.expression.name.getText(sourceFile)

  // mapErr without logging - SEVERITY: ERROR
  if (method === 'mapErr' && node.arguments.length > 0) {
    const firstArg = node.arguments[0]
    if (!firstArg) return violations
    const callback = firstArg.getText(sourceFile)
    if (!hasAcceptablePattern(callback)) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart())
      violations.push({
        line: line + 1,
        column: 0,
        message: 'mapErr() discards error without logging',
        severity: 'error',

        suggestion: 'Add logging: `mapErr(err => { logger.warn({ err }); return default; })`',
        match: 'mapErr',
      })
    }
  }

  // match() error handler without logging - SEVERITY: ERROR
  if (method === 'match' && node.arguments.length >= 2) {
    const secondArg = node.arguments[1]
    if (!secondArg) return violations
    const errHandler = secondArg.getText(sourceFile)
    if (!hasAcceptablePattern(errHandler)) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart())
      violations.push({
        line: line + 1,
        column: 0,
        message: "match() error handler doesn't log",
        severity: 'error',
        suggestion: 'Use matchLog() instead, or add logging to error handler',
        match: 'match',
      })
    }
  }

  return violations
}

/**
 * Check a catch clause for unsafe `as Error` casts
 */
function checkCatchClauseAsErrorCast(
  node: ts.CatchClause,
  sourceFile: ts.SourceFile,
): CheckViolation[] {
  const violations: CheckViolation[] = []
  const catchText = node.block.getText(sourceFile)

  // Skip if the catch block contains an instanceof Error guard
  if (catchText.includes('instanceof Error')) return violations

  // Check for `as Error` casts
  if (catchText.includes('as Error')) {
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart())
    const catchParam = node.variableDeclaration?.name.getText(sourceFile) ?? 'error'
    violations.push({
      line: line + 1,
      column: 0,
      message: 'Unsafe `as Error` cast in catch block without `instanceof Error` guard',
      severity: 'warning',
      suggestion: `Use \`if (${catchParam} instanceof Error)\` guard or normalize the error with a typed error utility`,
      match: 'as Error',
    })
  }

  return violations
}

// =============================================================================
// CHECK IMPLEMENTATION
// =============================================================================

/**
 * Check: quality/error-handling-quality
 *
 * Detects silent error handling in both try/catch and Result patterns.
 * This is a unified check that replaces:
 * - resilience/no-empty-catch
 * - quality/error-swallowing-boolean
 *
 */
export const errorHandlingQuality = defineCheck({
  id: '6bae5be9-87f4-499e-a886-ca78a233cfb7',
  slug: 'error-handling-quality',
  scope: { languages: ['typescript'], concerns: ['backend', 'server'] },
  contentFilter: 'strip-strings',
  confidence: 'high',
  description: 'Detect silent error handling in try/catch and Result patterns',
  longDescription: `**Purpose:** Detects silent error handling in both try/catch blocks and Result pattern usage, ensuring errors are always logged or propagated.

**Detects:** Analyzes each file individually using TypeScript AST. Checks for:
- Empty catch blocks (no logging, no rethrow, no \`@swallow-ok\` marker)
- Catch blocks that return sentinel values (\`false\`, \`null\`, \`undefined\`, \`[]\`, \`{}\`) without logging
- \`result.isErr()\` branches that silently return sentinel values
- \`mapErr()\` callbacks without logging
- \`match()\` error handlers without logging (suggests \`matchLog()\` instead)

**Why it matters:** Silent error handling hides failures, making production debugging nearly impossible and allowing cascading failures to go undetected.

**Scope:** General best practice`,
  tags: ['quality', 'resilience', 'error-handling', 'observability', 'result-pattern'],
  fileTypes: ['ts'],

  analyze(content, filePath) {
    // Skip test files — as Error casts, match()/mapErr() calls are exercising APIs, not production error handling
    if (isTestFile(filePath)) return []

    // Quick filter: must have catch or Result patterns
    if (!content.includes('catch') && !content.includes('isErr') && !content.includes('.match(')) {
      return []
    }

    const violations: CheckViolation[] = []

    const sourceFile = getSharedSourceFile(filePath, content)
    if (!sourceFile) return []

    const visit = (node: ts.Node): void => {
      if (ts.isCatchClause(node)) {
        violations.push(...checkCatchClause(node, sourceFile))
        violations.push(...checkCatchClauseAsErrorCast(node, sourceFile))
      }
      if (ts.isIfStatement(node)) {
        violations.push(...checkResultIsErr(node, sourceFile))
      }
      if (ts.isCallExpression(node)) {
        violations.push(...checkResultMethods(node, sourceFile))
      }
      ts.forEachChild(node, visit)
    }

    visit(sourceFile)
    return violations
  },
})
