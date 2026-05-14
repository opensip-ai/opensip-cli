// @fitness-ignore-file typeorm-n-plus-one -- This is the check definition itself; suggestion strings reference N+1 patterns for user guidance
// @fitness-ignore-file typeorm-n-plus-one -- Check definition contains N+1 pattern strings in suggestions/messages
/**
 * @fileoverview TypeORM N+1 Query Detection Check
 *
 * Detects N+1 query patterns in TypeORM usage:
 * - Loops that call findOne/findBy
 * - Promise.all with individual entity fetches
 * - Missing relations option in queries
 */

import * as ts from 'typescript'

import { defineCheck, type CheckViolation, extractSnippet } from '@opensip-tools/fitness'
import { getSharedSourceFile } from '@opensip-tools/lang-typescript'

/** TypeORM query methods */
const QUERY_METHODS = [
  'findOne',
  'findOneBy',
  'findOneOrFail',
  'findOneByOrFail',
  'findBy',
  'find',
  'findAndCount',
  'findAndCountBy',
]

/**
 * Checks if a loop body contains a query method call
 * @returns The matched method name if found, null otherwise
 */
function findQueryMethodInLoop(bodyText: string): string | null {
  for (const method of QUERY_METHODS) {
    const repositoryPattern = new RegExp(
      `(repository|Repository|this\\.[a-z]\\w*)\\.${method}\\s*\\(`,
      'gi',
    )

    if (repositoryPattern.test(bodyText)) {
      return method
    }
  }
  return null
}

/**
 * Checks if a Promise.all call contains a query method
 * @returns The matched method name if found, null otherwise
 */
function findQueryMethodInPromiseAll(callText: string): string | null {
  if (!callText.includes('Promise.all') || !callText.includes('.map(')) {
    return null
  }

  for (const method of QUERY_METHODS) {
    if (callText.includes(`.${method}(`)) {
      return method
    }
  }
  return null
}

/**
 * Check if a node is a loop statement
 */
function isLoopStatement(node: ts.Node): boolean {
  return (
    ts.isForStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isWhileStatement(node)
  )
}

/**
 * Check a loop node for N+1 query patterns
 * @returns Violation info if found, null otherwise
 */
function checkLoopForNPlusOne(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  content: string,
): {
  loopMethod: string
  line: number
  column: number
  snippet: string
  contextLines: number
} | null {
  const bodyText = node.getText(sourceFile)
  const loopMethod = findQueryMethodInLoop(bodyText)
  if (!loopMethod) return null

  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart())
  const lineNum = line + 1
  const { snippet, contextLines } = extractSnippet(content, lineNum)

  return { loopMethod, line: lineNum, column: character + 1, snippet, contextLines }
}

/**
 * Check a call expression for Promise.all N+1 patterns
 * @returns Violation info if found, null otherwise
 */
function checkPromiseAllForNPlusOne(
  node: ts.CallExpression,
  sourceFile: ts.SourceFile,
  content: string,
): {
  promiseMethod: string
  line: number
  column: number
  snippet: string
  contextLines: number
} | null {
  const callText = node.getText(sourceFile)
  const promiseMethod = findQueryMethodInPromiseAll(callText)
  if (!promiseMethod) return null

  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart())
  const lineNum = line + 1
  const { snippet, contextLines } = extractSnippet(content, lineNum)

  return { promiseMethod, line: lineNum, column: character + 1, snippet, contextLines }
}

/** Violation info types */
interface LoopViolationInfo {
  type: 'loop'
  method: string
  line: number
  column: number
  snippet: string
  contextLines: number
}

interface PromiseViolationInfo {
  type: 'promise'
  method: string
  line: number
  column: number
  snippet: string
  contextLines: number
}

type ViolationInfo = LoopViolationInfo | PromiseViolationInfo

/**
 * Scan a file for N+1 query patterns and return all violations found
 */
function scanFileForNPlusOne(content: string, filePath: string): ViolationInfo[] {
  // Quick filter: must have TypeORM patterns
  if (
    !QUERY_METHODS.some((m) => content.includes(m)) &&
    !content.includes('Repository') &&
    !content.includes('getRepository')
  ) {
    return []
  }

  const violations: ViolationInfo[] = []
  const sourceFile = getSharedSourceFile(filePath, content)
    if (!sourceFile) return []

  const visit = (node: ts.Node): void => {
    ts.forEachChild(node, visit)

    // Check for loops containing queries
    if (isLoopStatement(node)) {
      const loopViolation = checkLoopForNPlusOne(node, sourceFile, content)
      if (loopViolation) {
        violations.push({
          type: 'loop',
          method: loopViolation.loopMethod,
          line: loopViolation.line,
          column: loopViolation.column,
          snippet: loopViolation.snippet,
          contextLines: loopViolation.contextLines,
        })
      }
      return
    }

    // Check for Promise.all with map containing queries
    if (!ts.isCallExpression(node)) return

    const promiseViolation = checkPromiseAllForNPlusOne(node, sourceFile, content)
    if (promiseViolation) {
      violations.push({
        type: 'promise',
        method: promiseViolation.promiseMethod,
        line: promiseViolation.line,
        column: promiseViolation.column,
        snippet: promiseViolation.snippet,
        contextLines: promiseViolation.contextLines,
      })
    }
  }

  visit(sourceFile)
  return violations
}

/**
 * Analyze a file for N+1 query patterns
 */
function analyzeFile(content: string, filePath: string): CheckViolation[] {
  const internalViolations = scanFileForNPlusOne(content, filePath)

  return internalViolations.map((violation) => {
    const isLoop = violation.type === 'loop'
    const message = isLoop
      ? `N+1 query: ${violation.method}() called inside loop`
      : `N+1 query: Promise.all with individual ${violation.method}() calls`
    const suggestion = isLoop
      ? `Replace loop with batch query: collect IDs first, then use repository.findByIds(ids) or findBy({ id: In(ids) }) once outside the loop`
      : `Replace Promise.all(items.map(i => repo.${violation.method}(i))) with a single batch query: repo.findBy({ id: In(ids) })`

    return {
      line: violation.line,
      column: violation.column,
      message,
      severity: 'error' as const,
      suggestion,
      match: violation.method,
    }
  })
}

/**
 * Check: quality/typeorm-n-plus-one
 *
 * Detects N+1 query patterns in TypeORM usage.
 */
export const typeormNPlusOne = defineCheck({
  id: '782f02d3-a691-43e2-9762-b1320d240bc8',
  slug: 'typeorm-n-plus-one',
  disabled: true,
  scope: { languages: ['typescript'], concerns: ['backend', 'server'] },
  contentFilter: 'strip-strings',

  confidence: 'high',
  description: 'Detects N+1 query patterns in TypeORM usage',
  longDescription: `**Purpose:** Detects N+1 query patterns in TypeORM repository code where individual entity fetches occur inside loops or \`Promise.all\` map calls.

**Detects:**
- TypeORM query methods (\`findOne\`, \`findOneBy\`, \`findBy\`, \`find\`, \`findAndCount\`, \`findOneOrFail\`, \`findOneByOrFail\`, \`findAndCountBy\`) called on \`repository\`/\`Repository\`/\`this.*\` inside \`for\`, \`for-of\`, \`for-in\`, or \`while\` loops
- \`Promise.all(items.map(...))\` containing individual TypeORM query method calls
- Quick-filters files for TypeORM query method names and \`Repository\`/\`getRepository\` keywords

**Why it matters:** Fetching entities one-by-one in a loop generates N+1 database round-trips instead of a single batch query, causing severe latency under load.

**Scope:** General best practice. Analyzes each file individually.`,
  tags: ['quality', 'performance', 'code-quality', 'best-practices'],
  fileTypes: ['ts'],
  // @fitness-ignore-next-line no-hardcoded-timeouts -- framework default for fitness check execution
  timeout: 180000, // 3 minutes - analyzes TypeORM query patterns

  analyze: analyzeFile,
})
