// @fitness-ignore-file unused-config-options -- Config options reserved for future use or environment-specific
/**
 * @fileoverview Clean Code Naming Quality check
 *
 * Enforces Clean Code naming conventions for improved readability.
 * Based on Clean Code Ch.2 principles for meaningful names.
 */

import * as ts from 'typescript'

import { defineCheck, type CheckViolation } from '@opensip-tools/core'
import { getSharedSourceFile } from '@opensip-tools/core/framework/parse-cache.js'

/**
 * Minimum identifier length thresholds
 */
const MIN_VARIABLE_LENGTH = 2
const MIN_FUNCTION_LENGTH = 3
const MIN_CLASS_LENGTH = 3

/**
 * Known abbreviations that are acceptable
 */
const ALLOWED_SHORT_NAMES = new Set([
  'id',
  'ID',
  'i',
  'j',
  'k',
  'n',
  'x',
  'y',
  'z', // Loop/math variables
  'a',
  'b',
  'c',
  'd',
  'e',
  'f',
  'm',
  'p',
  'q',
  'r',
  's',
  't',
  'v',
  'w', // Single-letter iteration/callback params
  'db',
  'tx',
  'fs',
  'io',
  'ui',
  'os',
  'ok', // Common abbreviations
  'lo',
  'hi',
  'op',
  'ws',
  'el',
  'fd',
  'ip',
  'ts', // Algorithm/domain abbreviations
  'fn',
  'cb',
  'err',
  'req',
  'res',
  'ctx', // Callback/request patterns
  'on',
  'to',
  'at',
  'in',
  'as',
  'is',
  'do',
  'go',
  'up',
  'of', // Idiomatic short method/function names (e.g. EventEmitter.on, Array.of, Date.in)
  'Tx',
  'Rx',
  'Fn',
  'IO',
  'OS',
  'UI', // PascalCase short type/class names — Tx (transaction), Rx (reactive), Fn (function),
  // IO (input/output), OS (operating system), UI (user interface). Canonical structural-type and
  // domain abbreviations; requiring 3+ chars here just produces verbose synonyms (TransactionLike,
  // OsContext) without improving clarity.
  'T',
  'K',
  'V',
  'P',
  'R',
  'E',
  'S',
  'U',
  'A',
  'B',
  'C',
  'D',
  'F',
  'M',
  'N',
  'O',
  'W', // Type parameters
])

/**
 * Boolean prefixes that should be used for boolean variables
 */
const BOOLEAN_PREFIXES = ['is', 'has', 'can', 'should', 'will', 'did', 'was', 'are', 'does']

/**
 * Capitalize first letter
 */
function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1)
}

/**
 * Check variable name quality
 */
/**
 * Check if a variable declaration is inside a for-of, for-in, or catch clause
 * where short names are idiomatic.
 */
function isInLoopOrCatchBinding(node: ts.Node): boolean {
  let current: ts.Node = node
  while (current.parent && !ts.isSourceFile(current.parent)) {
    current = current.parent
    if (ts.isForOfStatement(current)) return true
    if (ts.isForInStatement(current)) return true
    if (ts.isForStatement(current)) return true
    if (ts.isCatchClause(current)) return true
    // Stop at function boundaries
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current) ||
      ts.isMethodDeclaration(current)
    ) {
      break
    }
  }
  return false
}

/**
 * Check if a variable is a callback/arrow function parameter where short names are common.
 */
function isCallbackParameter(node: ts.Node): boolean {
  const parent = node.parent
  if (!parent) return false
  // Parameter in an arrow function or function expression (callback)
  if (ts.isParameter(parent)) {
    const grandparent = parent.parent
    if (ts.isArrowFunction(grandparent) || ts.isFunctionExpression(grandparent)) {
      return true
    }
  }
  // Destructuring binding inside a parameter
  if (ts.isBindingElement(parent)) {
    let current: ts.Node = parent
    while (current.parent && !ts.isSourceFile(current.parent)) {
      current = current.parent
      if (ts.isParameter(current)) return true
    }
  }
  return false
}

function checkVariableName(
  name: string,
  node: ts.Node,
  sourceFile: ts.SourceFile,
  filePath: string,
): CheckViolation | null {
  // Skip allowed short names
  if (ALLOWED_SHORT_NAMES.has(name)) return null

  // Check minimum length (skip short names in loop bindings, catch clauses, and callback parameters)
  if (name.length < MIN_VARIABLE_LENGTH) {
    if (isInLoopOrCatchBinding(node) || isCallbackParameter(node)) return null
    const { line: lineIdx, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart())
    const line = lineIdx + 1
    return {
      line,
      column: character + 1,
      message: `Variable '${name}' is too short (${name.length} chars, min: ${MIN_VARIABLE_LENGTH})`,
      severity: 'warning',
      suggestion: `Rename '${name}' to a more descriptive name that reveals the intent of the variable (e.g., 'count', 'item', 'value')`,
      type: 'short-name',
      match: name,
      filePath,
    }
  }

  // Check boolean naming
  const parent = node.parent
  if (ts.isVariableDeclaration(parent) && parent.type) {
    const typeText = parent.type.getText(sourceFile)
    if (typeText === 'boolean' && !BOOLEAN_PREFIXES.some((p) => name.startsWith(p))) {
      const { line: lineIdx, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart())
      const line = lineIdx + 1
      return {
        line,
        column: character + 1,
        message: `Boolean '${name}' should use predicate prefix (is, has, can, etc.)`,
        severity: 'warning',
        suggestion: `Rename '${name}' to 'is${capitalize(name)}' or 'has${capitalize(name)}' for clearer boolean semantics`,
        type: 'boolean-naming',
        match: name,
        filePath,
      }
    }
  }

  return null
}

/**
 * Check function/method name quality
 */
function checkFunctionName(
  name: string,
  node: ts.Node,
  sourceFile: ts.SourceFile,
  filePath: string,
): CheckViolation | null {
  // Skip allowed short names
  if (ALLOWED_SHORT_NAMES.has(name)) return null

  // Check minimum length
  if (name.length < MIN_FUNCTION_LENGTH) {
    const { line: lineIdx, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart())
    const line = lineIdx + 1
    return {
      line,
      column: character + 1,
      message: `Function '${name}' is too short (${name.length} chars, min: ${MIN_FUNCTION_LENGTH})`,
      severity: 'warning',
      suggestion: `Rename '${name}' to a verb phrase that describes what the function does (e.g., 'getUser', 'calculateTotal', 'handleSubmit')`,
      type: 'short-name',
      match: name,
      filePath,
    }
  }

  return null
}

/**
 * Check class/interface name quality
 */
function checkClassName(
  name: string,
  node: ts.Node,
  sourceFile: ts.SourceFile,
  filePath: string,
): CheckViolation | null {
  // Check minimum length
  if (name.length < MIN_CLASS_LENGTH) {
    const { line: lineIdx, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart())
    const line = lineIdx + 1
    return {
      line,
      column: character + 1,
      message: `Class/Interface '${name}' is too short (${name.length} chars, min: ${MIN_CLASS_LENGTH})`,
      severity: 'warning',
      suggestion: `Rename '${name}' to a noun phrase that describes its responsibility (e.g., 'UserService', 'PaymentHandler', 'ConfigOptions')`,
      type: 'short-name',
      match: name,
      filePath,
    }
  }

  return null
}

function checkNodeNaming(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  filePath: string,
): CheckViolation | null {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
    return checkVariableName(node.name.text, node, sourceFile, filePath)
  }

  if (ts.isFunctionDeclaration(node) && node.name) {
    return checkFunctionName(node.name.text, node, sourceFile, filePath)
  }

  if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
    return checkFunctionName(node.name.text, node, sourceFile, filePath)
  }

  if (ts.isClassDeclaration(node) && node.name) {
    return checkClassName(node.name.text, node, sourceFile, filePath)
  }

  if (ts.isInterfaceDeclaration(node)) {
    return checkClassName(node.name.text, node, sourceFile, filePath)
  }

  return null
}

/**
 * Analyze a file for naming quality issues
 */
function analyzeFile(filePath: string, content: string): CheckViolation[] {
  const violations: CheckViolation[] = []

  try {
    const sourceFile = getSharedSourceFile(filePath, content)
    if (!sourceFile) return []

    const visit = (node: ts.Node): void => {
      const issue = checkNodeNaming(node, sourceFile, filePath)
      if (issue) violations.push(issue)
      ts.forEachChild(node, visit)
    }

    visit(sourceFile)
  } catch {
    // @swallow-ok Ignore parse errors
  }

  return violations
}

/**
 * Check: quality/clean-code-naming-quality
 *
 * Enforces meaningful names following Clean Code principles:
 * - Minimum length requirements
 * - Boolean predicates (isX, hasX, etc.)
 * - Searchable names
 */
export const cleanCodeNamingQuality = defineCheck({
  id: '8e27a337-8796-41af-9d6d-7cca1dfa1a20',
  slug: 'clean-code-naming-quality',
  scope: { languages: ['typescript'], concerns: ['backend', 'frontend', 'cli'] },

  confidence: 'high',
  description: 'Enforce meaningful names (min length, boolean predicates, searchable names)',
  longDescription: `**Purpose:** Enforces Clean Code naming conventions by requiring identifiers to be descriptive enough for code readability and searchability.

**Detects:** Analyzes each file individually using TypeScript AST traversal.
- Variables shorter than ${MIN_VARIABLE_LENGTH} characters (excluding allowed names like \`id\`, \`i\`, \`db\`, \`err\`, \`T\`, etc.)
- Functions/methods shorter than ${MIN_FUNCTION_LENGTH} characters
- Classes/interfaces shorter than ${MIN_CLASS_LENGTH} characters
- Boolean variables without predicate prefixes (\`is\`, \`has\`, \`can\`, \`should\`, \`will\`, \`did\`, \`was\`, \`are\`, \`does\`)

**Why it matters:** Short or non-descriptive names reduce code readability and make searching difficult. Boolean predicates make conditional logic self-documenting.

**Scope:** General best practice (Clean Code Ch.2)`,
  tags: ['quality', 'clean-code', 'naming', 'readability'],
  fileTypes: ['ts'],

  analyze(content: string, filePath: string): CheckViolation[] {
    return analyzeFile(filePath, content)
  },
})
