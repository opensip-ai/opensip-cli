// @fitness-ignore-file fitness-check-architecture -- Helper module for observability-coverage check, not a standalone check
/**
 * @fileoverview AST function extractor for observability coverage analysis
 */

import { getSharedSourceFile, isAsync } from '@opensip-tools/lang-typescript'
import * as ts from 'typescript'


import type { FunctionInfo } from './types.js'

/**
 * Recursively walk a subtree looking for a TryStatement.
 */
function containsTryCatch(node: ts.Node): boolean {
  if (ts.isTryStatement(node)) {
    return true
  }

  let found = false
  node.forEachChild((child) => {
    if (!found && containsTryCatch(child)) {
      found = true
    }
  })
  return found
}

/**
 * Check whether a node is a getter or setter accessor.
 */
function isAccessor(node: ts.Node): boolean {
  return ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)
}

/**
 * Check whether a function-like node has a body.
 * Abstract methods, overload signatures, and interface method signatures have no body.
 */
function hasBody(node: ts.Node): boolean {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
    return node.body !== undefined
  }
  /* v8 ignore next -- defensive AST/type guard */
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    return true
  }
  if (ts.isConstructorDeclaration(node)) {
    return node.body !== undefined
  }
  return false
}

/**
 * Build a FunctionInfo from a function-like AST node.
 */
function buildFunctionInfo(
  name: string,
  node: ts.Node,
  body: ts.Node,
  sourceFile: ts.SourceFile,
  filePath: string,
): FunctionInfo {
  const startPos = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
  const endPos = sourceFile.getLineAndCharacterOfPosition(node.getEnd())

  const startLine = startPos.line + 1
  const endLine = endPos.line + 1

  return {
    name,
    filePath,
    startLine,
    endLine,
    lineCount: endLine - startLine + 1,
    isAsync: isAsync(node),
    hasTryCatch: containsTryCatch(body),
    hasLogging: false,
    loggerCalls: [],
  }
}

/**
 * Extract functions, arrow functions, class methods, and constructors from
 * TypeScript source code using the raw compiler API.
 *
 * This module only performs AST extraction. Logger detection is handled
 * separately by the logger-detector module.
 */
export function extractFunctions(content: string, filePath: string): FunctionInfo[] {
  const parsed = getSharedSourceFile(filePath, content)
    /* v8 ignore next -- defensive AST/type guard */
    if (!parsed) return []
  const sourceFile: ts.SourceFile = parsed
  const functions: FunctionInfo[] = []

  function resolveFunctionExpressionName(node: ts.ArrowFunction | ts.FunctionExpression): string {
    if (ts.isVariableDeclaration(node.parent)) {
      return node.parent.name.getText(sourceFile)
    }
    if (ts.isPropertyAssignment(node.parent)) {
      return node.parent.name.getText(sourceFile)
    }
    /* v8 ignore next -- defensive AST/type guard */
    if (ts.isFunctionExpression(node) && node.name) {
      return node.name.getText(sourceFile)
    }
    return '<anonymous>'
  }

  function visit(node: ts.Node): void {
    // Skip getters and setters explicitly
    if (isAccessor(node)) {
      return
    }

    if (ts.isFunctionDeclaration(node) && hasBody(node) && node.body) {
      const name = node.name?.getText(sourceFile) ?? '<anonymous>'
      functions.push(buildFunctionInfo(name, node, node.body, sourceFile, filePath))
    } else if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      const name = resolveFunctionExpressionName(node)
      functions.push(buildFunctionInfo(name, node, node.body, sourceFile, filePath))
    } else if (ts.isConstructorDeclaration(node) && hasBody(node) && node.body) {
      functions.push(buildFunctionInfo('constructor', node, node.body, sourceFile, filePath))
    } else if (ts.isMethodDeclaration(node) && hasBody(node) && node.body) {
      const name = node.name.getText(sourceFile)
      functions.push(buildFunctionInfo(name, node, node.body, sourceFile, filePath))
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)

  return functions
}
