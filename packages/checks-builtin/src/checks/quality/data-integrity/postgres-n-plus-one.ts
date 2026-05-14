// @fitness-ignore-file unused-config-options -- Config options reserved for future use or environment-specific
/**
 * @fileoverview Postgres N+1 Query Detection Check
 *
 * Detects N+1 query patterns in postgres.js code by finding SQL queries
 * executed inside loops.
 */

import * as ts from 'typescript'

import { defineCheck, type CheckViolation } from '@opensip-tools/core'
import { getSharedSourceFile } from '@opensip-tools/lang-typescript'

interface LoopInfo {
  isLoop: boolean
  loopType: string
}

/**
 * Check if node is a for loop (for, for-in, for-of)
 * @param node - The AST node to check
 * @returns Loop info if it's a for loop
 */
function checkForLoop(node: ts.Node): LoopInfo | null {
  if (ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node)) {
    return { isLoop: true, loopType: 'for' }
  }
  return null
}

/**
 * Check if node is a while or do-while loop
 * @param node - The AST node to check
 * @returns Loop info if it's a while loop
 */
function checkWhileLoop(node: ts.Node): LoopInfo | null {
  if (ts.isWhileStatement(node)) {
    return { isLoop: true, loopType: 'while' }
  }
  if (ts.isDoStatement(node)) {
    return { isLoop: true, loopType: 'do-while' }
  }
  return null
}

/**
 * Array methods that iterate over elements
 */
const ARRAY_LOOP_METHODS = [
  'forEach',
  'map',
  'filter',
  'reduce',
  'some',
  'every',
  'find',
  'findIndex',
]

/**
 * Check if node is an array method call that loops
 * @param node - The AST node to check
 * @returns Loop info if it's an array loop method
 */
function checkArrayLoopMethod(node: ts.Node): LoopInfo | null {
  if (!ts.isCallExpression(node)) return null
  if (!ts.isPropertyAccessExpression(node.expression)) return null

  const methodName = node.expression.name.text
  if (ARRAY_LOOP_METHODS.includes(methodName)) {
    return { isLoop: true, loopType: methodName }
  }
  return null
}

/**
 * Check if node is a loop construct
 * @param node - The AST node to check
 * @returns Loop info with type, or non-loop if not a loop
 */
function isLoopNode(node: ts.Node): LoopInfo {
  const forLoop = checkForLoop(node)
  if (forLoop) return forLoop

  const whileLoop = checkWhileLoop(node)
  if (whileLoop) return whileLoop

  const arrayLoop = checkArrayLoopMethod(node)
  if (arrayLoop) return arrayLoop

  return { isLoop: false, loopType: '' }
}

/**
 * Check if node is a tagged template SQL call: sql`SELECT...`
 * @param node - The AST node to check
 * @returns True if it's a sql tagged template
 */
function isTaggedTemplateSqlCall(node: ts.Node): boolean {
  if (!ts.isTaggedTemplateExpression(node)) return false

  const tag = node.tag
  if (ts.isIdentifier(tag) && tag.text === 'sql') {
    return true
  }
  if (
    ts.isPropertyAccessExpression(tag) &&
    ts.isIdentifier(tag.expression) &&
    tag.expression.text === 'sql'
  ) {
    return true
  }
  return false
}

/**
 * Check if node is a function call SQL: sql(...) or sql.unsafe(...)
 * @param node - The AST node to check
 * @returns True if it's a sql function call
 */
function isFunctionCallSqlCall(node: ts.Node): boolean {
  if (!ts.isCallExpression(node)) return false

  const expr = node.expression
  if (ts.isIdentifier(expr) && expr.text === 'sql') {
    return true
  }
  if (
    ts.isPropertyAccessExpression(expr) &&
    ts.isIdentifier(expr.expression) &&
    expr.expression.text === 'sql'
  ) {
    return true
  }
  return false
}

/**
 * Check if node is a SQL call (postgres.js pattern)
 * @param node - The AST node to check
 * @returns True if it's a SQL call
 */
function isSqlCall(node: ts.Node): boolean {
  if (isTaggedTemplateSqlCall(node)) return true
  if (isFunctionCallSqlCall(node)) return true

  // await sql`...`
  if (ts.isAwaitExpression(node)) {
    return isSqlCall(node.expression)
  }

  return false
}

/**
 * Find SQL calls within a loop body
 * @param loopBody - The body of the loop to check
 * @param sourceFile - The source file for position information
 * @returns Array of line numbers where SQL calls were found
 */
function findSqlCallsInLoop(loopBody: ts.Node, sourceFile: ts.SourceFile): { line: number }[] {
  const sqlCalls: { line: number }[] = []

  const visit = (node: ts.Node): void => {
    // Check arrow functions (callbacks) but not nested function definitions
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      ts.forEachChild(node.body, visit)
      return
    }

    // Skip standalone function declarations
    if (ts.isFunctionDeclaration(node)) {
      return
    }

    if (isSqlCall(node)) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart())
      sqlCalls.push({ line: line + 1 })
      return // Don't recurse into SQL call children (e.g., sql.json() inside sql`...` is not a separate query)
    }

    ts.forEachChild(node, visit)
  }

  visit(loopBody)
  return sqlCalls
}

/**
 * Get the body of a for/for-in/for-of loop
 * @param node - The loop node
 * @returns The body of the loop, or undefined
 */
function getForLoopBody(node: ts.Node): ts.Node | undefined {
  if (ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node)) {
    return node.statement
  }
  return undefined
}

/**
 * Get the body of a while/do-while loop
 * @param node - The loop node
 * @returns The body of the loop, or undefined
 */
function getWhileLoopBody(node: ts.Node): ts.Node | undefined {
  if (ts.isWhileStatement(node) || ts.isDoStatement(node)) {
    return node.statement
  }
  return undefined
}

/**
 * Get the body of an array method callback
 * @param node - The call expression node
 * @returns The callback body, or undefined
 */
function getArrayMethodBody(node: ts.Node): ts.Node | undefined {
  if (!ts.isCallExpression(node)) return undefined

  const callback = node.arguments[0]
  if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
    return callback.body
  }
  return undefined
}

/**
 * Get the body of a loop node
 * @param node - The loop node
 * @returns The body of the loop, or undefined if not found
 */
function getLoopBody(node: ts.Node): ts.Node | undefined {
  const forBody = getForLoopBody(node)
  if (forBody) return forBody

  const whileBody = getWhileLoopBody(node)
  if (whileBody) return whileBody

  return getArrayMethodBody(node)
}

/**
 * Analyze a file for N+1 query patterns
 */
function analyzeFile(content: string, filePath: string): CheckViolation[] {
  const violations: CheckViolation[] = []

  // Quick filter: skip files without postgres.js patterns
  if (!content.includes('sql`') && !content.includes('sql(') && !content.includes('sql.')) {
    return violations
  }

  try {
    const sourceFile = getSharedSourceFile(filePath, content)
    if (!sourceFile) return []

    const visit = (node: ts.Node): void => {
      const { isLoop, loopType } = isLoopNode(node)

      if (isLoop) {
        const loopBody = getLoopBody(node)

        if (loopBody) {
          const sqlCalls = findSqlCallsInLoop(loopBody, sourceFile)

          for (const call of sqlCalls) {
            const lines = content.split('\n')
            const matchText = lines[call.line - 1] ?? ''

            violations.push({
              line: call.line,
              column: 0,
              message: `SQL query inside ${loopType} loop may cause N+1 query performance issue`,
              severity: 'error',
              suggestion: `Batch the queries: collect IDs first, then execute a single query with WHERE id IN (...) or use sql\`...WHERE id = ANY($\{ids})\` outside the loop`,
              match: matchText,
            })
          }
        }
      }

      ts.forEachChild(node, visit)
    }

    visit(sourceFile)
  } catch {
    // @swallow-ok Skip unreadable files
  }

  return violations
}

/**
 * Check: quality/postgres-n-plus-one
 *
 * Detects N+1 query patterns in postgres.js code.
 */
export const postgresNPlusOne = defineCheck({
  id: 'aa38310c-2631-4e41-9586-cf6e8fc8ff39',
  slug: 'postgres-n-plus-one',
  disabled: true,
  scope: { languages: ['typescript'], concerns: ['backend', 'server'] },

  confidence: 'high',
  description: 'Detects N+1 query patterns in postgres.js code',
  longDescription: `**Purpose:** Detects SQL queries executed inside loops in postgres.js code, which cause N+1 query performance degradation.

**Detects:**
- \`sql\` tagged template literals (\`sql\\\`SELECT...\\\`\`) or \`sql()\`/\`sql.*()\` function calls inside \`for\`, \`for-of\`, \`for-in\`, \`while\`, \`do-while\` loops
- SQL calls inside array iteration callbacks: \`forEach\`, \`map\`, \`filter\`, \`reduce\`, \`some\`, \`every\`, \`find\`, \`findIndex\`
- Handles \`await sql\\\`...\\\`\` expressions and nested arrow function callbacks within loops
- Quick-filters files for \`sql\\\`\`, \`sql(\`, or \`sql.\` patterns

**Why it matters:** Executing individual queries per loop iteration turns O(1) batch operations into O(N) sequential queries, causing severe performance degradation under load.

**Scope:** General best practice. Analyzes each file individually.`,
  tags: ['performance', 'database', 'quality'],
  fileTypes: ['ts'],
  // @fitness-ignore-next-line no-hardcoded-timeouts -- framework default for fitness check execution
  timeout: 180000, // 3 minutes - analyzes query patterns

  analyze: analyzeFile,
})
