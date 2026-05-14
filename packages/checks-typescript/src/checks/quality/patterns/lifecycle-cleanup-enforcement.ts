/**
 * @fileoverview Lifecycle Cleanup Enforcement check
 *
 * Detects resources with lifecycle methods (destroy, close, shutdown, stop, disconnect)
 * that are created but never have their cleanup method called in the same scope.
 * Unlike dispose-pattern-completeness (which checks IDisposable implementations),
 * this check analyzes call-sites for proper resource cleanup.
 */

import * as ts from 'typescript'

import { defineCheck, type CheckViolation } from '@opensip-tools/fitness'
import { getSharedSourceFile } from '@opensip-tools/lang-typescript'

/**
 * Describes a known type that has lifecycle methods requiring cleanup.
 */
interface LifecycleType {
  /** Class or constructor name */
  readonly name: string
  /** Lifecycle methods that must be called for proper cleanup */
  readonly methods: readonly string[]
}

/**
 * Phase 1: Hardcoded registry of known types with lifecycle methods.
 * Avoids the complexity of dynamic type scanning.
 * Extend this list as new lifecycle types are identified.
 */
const KNOWN_LIFECYCLE_TYPES: readonly LifecycleType[] = [
  { name: 'SipDataClient', methods: ['destroy'] },
]

/**
 * Set of all known type names for quick filtering.
 */
const KNOWN_TYPE_NAMES = new Set(KNOWN_LIFECYCLE_TYPES.map((t) => t.name))

/**
 * Context for creating violations from AST analysis.
 */
interface ViolationContext {
  readonly absolutePath: string
  readonly content: string
  readonly sourceFile: ts.SourceFile
}

/**
 * Tracks a resource creation site and its expected cleanup methods.
 */
interface ResourceCreation {
  /** Variable name the resource was assigned to */
  readonly variableName: string
  /** The lifecycle type information */
  readonly lifecycleType: LifecycleType
  /** AST node of the variable declaration */
  readonly node: ts.VariableDeclaration
  /** The enclosing function or block scope */
  readonly scope: ts.Node
}

/**
 * Find the enclosing function or block scope of a node.
 * Walks up the AST to find the nearest function-like or source file boundary.
 * @param node - The AST node to find the scope for
 * @returns The enclosing scope node
 */
function findEnclosingScope(node: ts.Node): ts.Node {
  let current: ts.Node | undefined = node.parent
  while (current) {
    if (
      // eslint-disable-next-line sonarjs/expression-complexity -- All six TypeScript AST node type checks are required to identify function-like scope boundaries
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current) ||
      ts.isMethodDeclaration(current) ||
      ts.isConstructorDeclaration(current) ||
      ts.isSourceFile(current)
    ) {
      return current
    }
    current = current.parent as ts.Node | undefined
  }
  return node.getSourceFile()
}

/**
 * Check if a node is a `new KnownType(...)` expression.
 * @param node - The AST node to check
 * @returns The matching LifecycleType or undefined
 */
function getLifecycleTypeFromNewExpression(node: ts.Expression): LifecycleType | undefined {
  if (!ts.isNewExpression(node)) {
    return undefined
  }

  const expression = node.expression
  if (!ts.isIdentifier(expression)) {
    return undefined
  }

  const typeName = expression.text
  return KNOWN_LIFECYCLE_TYPES.find((t) => t.name === typeName)
}

/**
 * Check if a scope contains a cleanup call for the given variable and method.
 * Searches for patterns like: `variableName.method()`, `await variableName.method()`,
 * or references within try/finally blocks.
 * @param scope - The enclosing scope to search
 * @param variableName - The variable name to check
 * @param method - The lifecycle method to look for
 * @param sourceFile - The source file for text extraction
 * @returns True if a cleanup call was found
 */
function hasCleanupCallInScope(
  scope: ts.Node,
  variableName: string,
  method: string,
  sourceFile: ts.SourceFile,
): boolean {
  let found = false

  const visit = (node: ts.Node): void => {
    if (found) {
      return
    }

    // Check for direct call: variableName.method()
    if (ts.isCallExpression(node)) {
      const expr = node.expression
      if (
        ts.isPropertyAccessExpression(expr) &&
        ts.isIdentifier(expr.expression) &&
        expr.expression.text === variableName &&
        expr.name.text === method
      ) {
        found = true
        return
      }
    }

    // Check for optional chaining: variableName?.method()
    if (ts.isCallExpression(node)) {
      const nodeText = node.getText(sourceFile)
      if (
        nodeText.includes(`${variableName}?.${method}(`) ||
        nodeText.includes(`${variableName}.${method}(`)
      ) {
        found = true
        return
      }
    }

    ts.forEachChild(node, visit)
  }

  ts.forEachChild(scope, visit)
  return found
}

/**
 * Check if the file defines (contains the class declaration for) any known lifecycle type.
 * These files are the implementations, not consumers, and should be skipped.
 * @param content - The file content
 * @returns True if the file contains a class definition for a known type
 */
function isClassDefinitionFile(content: string): boolean {
  for (const typeName of KNOWN_TYPE_NAMES) {
    if (content.includes(`class ${typeName}`)) {
      return true
    }
  }
  return false
}

/**
 * Find all resource creation sites in the AST.
 * Looks for variable declarations where the initializer is `new KnownType(...)`.
 * @param sourceFile - The parsed TypeScript source file
 * @returns Array of resource creation records
 */
function findResourceCreations(sourceFile: ts.SourceFile): ResourceCreation[] {
  const creations: ResourceCreation[] = []

  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const lifecycleType = getLifecycleTypeFromNewExpression(node.initializer)
      if (lifecycleType && ts.isIdentifier(node.name)) {
        creations.push({
          variableName: node.name.text,
          lifecycleType,
          node,
          scope: findEnclosingScope(node),
        })
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return creations
}

/**
 * Create a violation for a resource that is missing cleanup.
 * @param ctx - Violation context
 * @param creation - The resource creation record
 * @param missingMethods - The lifecycle methods that were not called
 * @returns CheckViolation object
 */
function createMissingCleanupViolation(
  ctx: ViolationContext,
  creation: ResourceCreation,
  missingMethods: readonly string[],
): CheckViolation {
  const { line: lineIdx, character } = ctx.sourceFile.getLineAndCharacterOfPosition(
    creation.node.getStart(),
  )
  const line = lineIdx + 1
  const methodList = missingMethods.join(', ')

  return {
    line,
    column: character + 1,
    message: `Resource '${creation.variableName}' (${creation.lifecycleType.name}) is created but never cleaned up. Missing call to: ${methodList}`,
    severity: 'warning',
    suggestion: `Add '${creation.variableName}.${missingMethods[0]}()' in a finally block or cleanup handler to prevent resource leaks`,
    type: 'missing-lifecycle-cleanup',
    match: `new ${creation.lifecycleType.name}`,
  }
}

/**
 * Analyze a file for lifecycle cleanup coverage.
 * Walks the AST to find resource creations and checks that cleanup methods are called.
 * @param absolutePath - The file path
 * @param content - The file content
 * @returns Array of violations for uncleaned resources
 */
function analyzeCleanupCoverage(absolutePath: string, content: string): CheckViolation[] {
  const violations: CheckViolation[] = []

  // Skip files that define the lifecycle types themselves
  if (isClassDefinitionFile(content)) {
    return violations
  }

  const sourceFile = getSharedSourceFile(absolutePath, content)
    if (!sourceFile) return []

  const ctx: ViolationContext = { absolutePath, content, sourceFile }

  const creations = findResourceCreations(sourceFile)

  for (const creation of creations) {
    const missingMethods: string[] = []

    for (const method of creation.lifecycleType.methods) {
      if (!hasCleanupCallInScope(creation.scope, creation.variableName, method, sourceFile)) {
        missingMethods.push(method)
      }
    }

    if (missingMethods.length > 0) {
      violations.push(createMissingCleanupViolation(ctx, creation, missingMethods))
    }
  }

  return violations
}

/**
 * Check: quality/lifecycle-cleanup-enforcement
 *
 * Detects resources with lifecycle methods (destroy, close, shutdown, stop, disconnect)
 * created without cleanup. Uses a hardcoded registry of known types for Phase 1.
 */
export const lifecycleCleanupEnforcement = defineCheck({
  id: '6350ce24-8ccc-4607-a962-8b067633547c',
  slug: 'lifecycle-cleanup-enforcement',
  scope: { languages: ['typescript'], concerns: ['backend', 'server'] },

  confidence: 'high',
  description:
    'Detect resources with lifecycle methods (destroy/close/shutdown) created without cleanup',
  longDescription: `**Purpose:** Detects resources with lifecycle methods that are created but never have their cleanup method called in the same scope.

**Detects:** Analyzes each file individually using TypeScript AST. Looks for \`new KnownType()\` variable declarations (currently: \`SipDataClient\`) and verifies that the required cleanup method (\`destroy()\`) is called on the variable within the enclosing function scope.

**Why it matters:** Resources without cleanup calls cause connection leaks, file descriptor exhaustion, and memory leaks that accumulate over the application lifetime.

**Scope:** Codebase-specific convention (hardcoded registry of known lifecycle types)`,
  tags: ['quality', 'resources', 'memory', 'cleanup', 'lifecycle'],
  fileTypes: ['ts'],

  analyze(content, filePath) {
    // Quick filter: skip files that do not reference any known lifecycle type
    const hasKnownType = [...KNOWN_TYPE_NAMES].some((name) => content.includes(name))
    if (!hasKnownType) {
      return []
    }

    return analyzeCleanupCoverage(filePath, content)
  },
})
