// @fitness-ignore-file lazy-loading -- Self-referential false positive: check code contains 'await' and 'validate' as analysis targets, not actual async/validation patterns
/**
 * @fileoverview Lazy Loading / Fail Fast Check
 *
 * Detects patterns where expensive operations (await calls) are performed
 * before validation checks that don't depend on those operations.
 */

import * as ts from 'typescript'

import { defineCheck, type CheckViolation } from '@opensip-tools/fitness'
import { getSharedSourceFile } from '@opensip-tools/lang-typescript'

/**
 * Options for analyzing a function body for fail-fast violations
 */
interface AnalyzeFunctionBodyOptions {
  body: ts.Node
  sourceFile: ts.SourceFile
  filePath: string
  violations: CheckViolation[]
}

/**
 * Patterns that indicate acceptable early loading
 */
const ACCEPTABLE_PATTERNS = [
  /\/\/ @lazy-ok/, // Explicit marker
  /\/\/ intentionally/i,
  /\/\/ required for/i,
]

/**
 * Extract all variable names assigned from an await expression in a statement.
 * Handles simple assignment (`const result = await ...`), destructured assignment
 * (`const { data, error } = await ...`), and array destructuring (`const [a, b] = await ...`).
 * @param {string} codeText - The statement text to extract variables from
 * @returns {string[]} Array of variable names assigned from the await
 */
function extractAwaitAssignedVariables(codeText: string): string[] {
  // @lazy-ok -- 'await' appears as a string literal for pattern matching, not an actual await expression
  if (!codeText.includes('await')) return []

  const vars: string[] = []

  // Simple assignment: const/let/var foo = await ...
  const simpleMatch = codeText.match(/(?:const|let|var)\s+(\w+)\s*=\s*await\b/)
  if (simpleMatch?.[1]) {
    vars.push(simpleMatch[1])
    return vars
  }

  // Object destructuring: const { a, b } = await ...
  const objectDestructureMatch = codeText.match(/(?:const|let|var)\s*\{([^}]+)\}\s*=\s*await\b/)
  if (objectDestructureMatch?.[1]) {
    const inner = objectDestructureMatch[1]
    const identifiers = inner.match(/\w+/g)
    if (identifiers) {
      for (const id of identifiers) {
        vars.push(id)
      }
    }
    return vars
  }

  // Array destructuring: const [a, b] = await ...
  const arrayDestructureMatch = codeText.match(/(?:const|let|var)\s*\[([^\]]+)\]\s*=\s*await\b/)
  if (arrayDestructureMatch?.[1]) {
    const inner = arrayDestructureMatch[1]
    const identifiers = inner.match(/\w+/g)
    if (identifiers) {
      for (const id of identifiers) {
        vars.push(id)
      }
    }
    return vars
  }

  // No variable assignment (bare await like `await repo.delete(id)`)
  return vars
}

/**
 * Check if a single ancestor node indicates the statement is inside a try block with an await.
 * @param {ts.Node} ancestor - The ancestor node to check
 * @param {ts.SourceFile} sourceFile - The source file for text extraction
 * @returns {boolean} True if this ancestor is a try-related node containing an await
 */
function ancestorIsTryWithAwait(ancestor: ts.Node, sourceFile: ts.SourceFile): boolean {
  if (ts.isTryStatement(ancestor)) {
    const tryText = ancestor.tryBlock.getText(sourceFile)
    // @lazy-ok -- 'await' appears as a string literal for pattern matching, not an actual await expression
    if (tryText.includes('await')) {
      return true
    }
  }
  // Also handle: the ancestor is a Block whose parent is a TryStatement
  if (ts.isBlock(ancestor) && ts.isTryStatement(ancestor.parent)) {
    const tryText = ancestor.getText(sourceFile)
    // @lazy-ok -- 'await' appears as a string literal for pattern matching, not an actual await expression
    if (tryText.includes('await')) {
      return true
    }
  }
  return false
}

/**
 * Check if a statement is inside a try block that also contains an await.
 * If so, the validation almost certainly depends on the awaited result.
 * @param {ts.Statement} stmt - The statement to check
 * @param {ts.SourceFile} sourceFile - The source file for text extraction
 * @returns {boolean} True if the statement is in a try block with an await
 */
function isInsideTryWithAwait(stmt: ts.Statement, sourceFile: ts.SourceFile): boolean {
  let ancestor: ts.Node = stmt.parent
  while (!ts.isSourceFile(ancestor)) {
    if (ancestorIsTryWithAwait(ancestor, sourceFile)) {
      return true
    }
    ancestor = ancestor.parent
  }
  return false
}

/**
 * State tracked while scanning statements for await expressions and validation patterns.
 */
interface AwaitTrackingState {
  firstAwaitLine: number | null
  // @lazy-ok -- Set tracks variable names containing 'await' as strings; no actual async operation here
  awaitAssignedVars: Set<string>
  hasUnassignedAwait: boolean
}

/**
 * Update await tracking state for a statement that contains an await expression.
 * @param {AwaitTrackingState} state - Mutable tracking state
 * @param {string} codeText - The statement text
 * @param {number} line - The 0-indexed line number
 */
function trackAwaitExpression(state: AwaitTrackingState, codeText: string, line: number): void {
  state.firstAwaitLine ??= line + 1
  const vars = extractAwaitAssignedVariables(codeText)
  if (vars.length === 0) {
    // Bare await with no assignment (e.g., `await repo.delete(id)`)
    state.hasUnassignedAwait = true
  }
  for (const varName of vars) {
    state.awaitAssignedVars.add(varName)
  }
}

/**
 * Determine whether a validation statement should be skipped (no violation).
 * Returns true if the validation is a false positive.
 */
function shouldSkipValidation(
  codeText: string,
  state: AwaitTrackingState,
  stmt: ts.Statement,
  sourceFile: ts.SourceFile,
): boolean {
  // Skip if validation depends on any tracked await-assigned variable
  if (dependsOnAwaitResult(codeText, state.awaitAssignedVars)) return true
  // Skip if the most recent await had no assignment (nothing to validate before it)
  if (state.hasUnassignedAwait && state.awaitAssignedVars.size === 0) return true
  // Skip if validation is inside a try block that contains an await
  if (isInsideTryWithAwait(stmt, sourceFile)) return true
  return false
}

/**
 * Analyze a function body for fail-fast violations.
 *
 * Tracks ALL variables assigned from await expressions (not just the first)
 * and handles destructured patterns, bare await (no assignment), and
 * try-catch dependency recognition.
 *
 * @param {AnalyzeFunctionBodyOptions} options - The analysis options
 */
function analyzeFunctionBody(options: AnalyzeFunctionBodyOptions): void {
  const { body, sourceFile, filePath, violations } = options

  if (!ts.isBlock(body)) return

  const statements = body.statements
  const state: AwaitTrackingState = {
    firstAwaitLine: null,
    awaitAssignedVars: new Set<string>(),
    hasUnassignedAwait: false,
  }

  for (const stmt of statements) {
    const fullText = stmt.getFullText(sourceFile)
    // Use getText() (excludes leading trivia/comments) for code analysis
    // to avoid false positives from comment text containing "validate"
    const codeText = stmt.getText(sourceFile)
    const { line } = sourceFile.getLineAndCharacterOfPosition(stmt.getStart())

    // Check for acceptable patterns (uses fullText to see leading comments like @lazy-ok)
    if (ACCEPTABLE_PATTERNS.some((p) => p.test(fullText))) {
      continue
    }

    // Track ALL await expressions and their assigned variables (uses codeText to avoid matching 'await' in comments)
    // @lazy-ok -- 'await' appears as a string literal for pattern matching, not an actual await expression
    if (codeText.includes('await')) {
      trackAwaitExpression(state, codeText, line)
    }

    // Check for validation after await that doesn't use await result
    // Uses codeText so comments containing "validate" don't trigger false positives
    if (
      state.firstAwaitLine !== null &&
      isValidationStatement(codeText) &&
      !shouldSkipValidation(codeText, state, stmt, sourceFile)
    ) {
      violations.push({
        filePath,
        line: line + 1,
        column: 0,
        message: `Fail-fast violation: validation check on line ${line + 1} could run before await on line ${state.firstAwaitLine}`,
        severity: 'warning',
        type: 'lazy-loading/fail-fast',
        suggestion:
          'Move validation checks before expensive await operations to fail fast and avoid unnecessary I/O.',
        match: 'validation after await',
      })
    }
  }
}

// Safe regex patterns for validation detection
const NEGATION_IF_PATTERN = /if\s*\(\s*!/
const THROW_ERROR_PATTERN = /throw\s+new\s+\w+Error/

/**
 * Check if statement is a validation check
 * @param {string} text - The statement text to check
 * @returns {boolean} True if the statement is a validation check
 */
function isValidationStatement(text: string): boolean {
  if (NEGATION_IF_PATTERN.test(text)) return true
  if (THROW_ERROR_PATTERN.test(text)) return true
  if (text.includes('assert(')) return true
  if (text.includes('validate')) return true
  return false
}

/**
 * Check if validation depends on any await-assigned variable
 * @param {string} validationText - The validation statement text
 * @param {Set<string>} awaitVars - Set of all variable names assigned from await expressions
 * @returns {boolean} True if the validation depends on any await result
 */
function dependsOnAwaitResult(validationText: string, awaitVars: Set<string>): boolean {
  for (const varName of awaitVars) {
    if (validationText.includes(varName)) {
      return true
    }
  }
  return false
}

/**
 * Analyze a file for lazy loading issues
 * @param {string} content - The file content to analyze
 * @param {string} filePath - The path to the file being analyzed
 * @returns {CheckViolation[]} Array of violations found in the file
 */
function analyzeFile(content: string, filePath: string): CheckViolation[] {
  const violations: CheckViolation[] = []

  // @lazy-ok -- 'await' appears as a string literal, not an actual await expression
  // Quick filter: skip files without await
  if (!content.includes('await')) {
    return violations
  }

  try {
    const sourceFile = getSharedSourceFile(filePath, content)
    if (!sourceFile) return []

    const visit = (node: ts.Node): void => {
      // Look for function/method bodies
      if (
        (ts.isFunctionDeclaration(node) ||
          ts.isMethodDeclaration(node) ||
          ts.isArrowFunction(node)) &&
        node.body
      ) {
        analyzeFunctionBody({ body: node.body, sourceFile, filePath, violations })
      }
      ts.forEachChild(node, visit)
    }

    visit(sourceFile)
  } catch {
    // @swallow-ok Skip files that fail to parse
  }

  return violations
}

/**
 * Check: quality/lazy-loading
 *
 * Detects expensive operations performed before unused guard clauses.
 */
export const lazyLoading = defineCheck({
  id: 'a58f74a8-65b0-4ab6-9a1a-385e9f8dcf9a',
  slug: 'lazy-loading',
  disabled: true,
  scope: { languages: ['typescript', 'tsx'], concerns: ['frontend', 'ui'] },
  contentFilter: 'strip-strings',

  confidence: 'high',
  description: 'Detect expensive operations performed before unused guard clauses',
  longDescription: `**Purpose:** Enforces the fail-fast principle by detecting validation checks that appear after expensive \`await\` operations when the validation does not depend on the awaited result.

**Detects:** Analyzes each file individually using TypeScript AST traversal of function bodies.
- Statements containing \`await\` followed by validation patterns (\`if (!...\`, \`throw new ...Error\`, \`assert(\`, \`validate\`) that do not reference any awaited variable
- Tracks ALL await-assigned variables (not just the first), including destructured patterns (\`const { data } = await ...\`)
- Skips validations inside try blocks that contain an await (implicit dependency)
- Skips validations after bare await expressions with no assignment (\`await repo.delete(id)\`)
- Respects \`// @lazy-ok\`, \`// intentionally\`, and \`// required for\` exemption comments

**Why it matters:** Performing I/O before guard clauses wastes resources on requests that will fail anyway. Moving validation first avoids unnecessary database/network calls.

**Scope:** General best practice. Analyzes each file individually.`,
  tags: ['quality', 'code-quality', 'performance'],
  fileTypes: ['ts'],

  analyze: analyzeFile,
})
