// @fitness-ignore-file fitness-check-architecture -- Helper module for observability-coverage check, not a standalone check
/**
 * @fileoverview Logger call detector for observability coverage analysis
 */

import { getSharedSourceFile } from '@opensip-tools/lang-typescript'
import * as ts from 'typescript'


import type { LoggerCall } from './types.js'

/** Logger method names we recognize as logging calls */
const LOGGER_METHODS = new Set(['info', 'warn', 'error', 'debug'])

/**
 * Detect logger calls within a specific line range of a source file.
 *
 * Walks the AST looking for:
 * - Property access calls like `logger.info(...)`, `logger.warn(...)`, etc.
 * - Direct calls to `logToFitnessFile(...)` or `logToCLIFile(...)`
 *
 * @param content - Full source file content
 * @param filePath - Path to the source file (used for AST parsing)
 * @param startLine - 1-indexed start line of the range to inspect
 * @param endLine - 1-indexed end line of the range to inspect
 * @returns Array of detected logger calls within the given line range
 */
export function detectLoggerCalls(
  content: string,
  filePath: string,
  startLine: number,
  endLine: number,
): LoggerCall[] {
  const sourceFile = getSharedSourceFile(filePath, content)
  /* v8 ignore next -- defensive guard */
  if (!sourceFile) return []
  // Local non-nullable alias so the nested `visit` function declaration —
  // which TypeScript treats as hoisted and therefore non-narrowing — can
  // still see a non-null SourceFile.
  const sf = sourceFile

  const calls: LoggerCall[] = []

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const call = extractLoggerCall(node, sf, startLine, endLine)
      if (call) {
        calls.push(call)
      }
    }

    ts.forEachChild(node, visit)
  }

  ts.forEachChild(sf, visit)

  return calls
}

/**
 * Check whether an expression resolves to a logger instance.
 *
 * Matches:
 * - `logger`          (bare identifier)
 * - `this.logger`     (class instance property)
 */
function isLoggerReceiver(node: ts.Expression): boolean {
  // logger.info(...)
  if (ts.isIdentifier(node) && node.text === 'logger') {
    return true
  }

  // this.logger.info(...)
  if (
    ts.isPropertyAccessExpression(node) &&
    node.expression.kind === ts.SyntaxKind.ThisKeyword &&
    node.name.text === 'logger'
  ) {
    return true
  }

  return false
}

/**
 * Extract a LoggerCall from a call expression if it matches our patterns.
 *
 * @returns A LoggerCall if the node is a recognized logger call within range, or undefined
 */
function extractLoggerCall(
  node: ts.CallExpression,
  sourceFile: ts.SourceFile,
  startLine: number,
  endLine: number,
): LoggerCall | undefined {
  // @fitness-ignore-next-line null-safety -- getLineAndCharacterOfPosition always returns a valid {line, character} object
  const lineNumber = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1

  if (lineNumber < startLine || lineNumber > endLine) {
    return undefined
  }

  // Check for property access calls: logger.info(...), this.logger.warn(...), etc.
  if (ts.isPropertyAccessExpression(node.expression)) {
    const propertyAccess = node.expression
    // @fitness-ignore-next-line null-safety -- ts.isPropertyAccessExpression guarantees .name is a valid Identifier node
    const methodName = propertyAccess.name.text

    if (LOGGER_METHODS.has(methodName) && isLoggerReceiver(propertyAccess.expression)) {
      return {
        line: lineNumber,
        level: methodName as LoggerCall['level'],
      }
    }
  }

  // Check for direct calls: logToFitnessFile(...), logToCLIFile(...)
  if (
    ts.isIdentifier(node.expression) &&
    (node.expression.text === 'logToFitnessFile' || node.expression.text === 'logToCLIFile')
  ) {
    return {
      line: lineNumber,
      level: 'info',
    }
  }

  return undefined
}

/**
 * Check whether a file imports a logger.
 *
 * Looks for imports from a structured logger module,
 * imports of `logToFitnessFile`, or imports of `logToCLIFile`.
 *
 * @param content - Full source file content
 * @returns True if the file imports a logger, false otherwise
 */
export function fileImportsLogger(content: string): boolean {
  return (
    /(?:\/logger['"]|from\s+['"][^'"]*logger)/.test(content) ||
    content.includes('logToFitnessFile') ||
    content.includes('logToCLIFile')
  )
}
