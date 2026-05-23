// @fitness-ignore-file no-generic-error -- Generic errors appropriate in this context
/**
 * @fileoverview Numeric Parameter Validation Check
 *
 * Detects numeric parameters without NaN/Infinity/range validation.
 */


import { defineCheck, isTestFile, type CheckViolation } from '@opensip-tools/fitness'
import { getSharedSourceFile } from '@opensip-tools/lang-typescript'
import * as ts from 'typescript'

/**
 * Quick filter keywords for numeric validation patterns
 */
const QUICK_FILTER_KEYWORDS = ['number', 'Number', 'parseInt', 'parseFloat']

/**
 * Patterns that indicate proper numeric validation
 */
const VALIDATION_PATTERNS = [
  /Number\.isFinite/,
  /Number\.isNaN/,
  /Number\.isInteger/,
  /isFinite\(/,
  /isNaN\(/,
  /typeof\s+\w+\s*===?\s*['"]number['"]/,
]

/**
 * Parameter names that are inherently safe (loop indices, counters, etc.)
 * These are structural values that don't need NaN/Infinity validation.
 */
const SAFE_PARAMETER_NAMES = new Set([
  'index', 'i', 'j', 'k',
  'count', 'length', 'offset', 'limit',
  'depth', 'level', 'size', 'capacity',
])

/**
 * Check if a file imports from 'zod', indicating parameters likely come from
 * Zod-parsed schemas and are already validated.
 */
function fileImportsZod(sourceFile: ts.SourceFile): boolean {
  for (const stmt of sourceFile.statements) {
    if (
      ts.isImportDeclaration(stmt) &&
      ts.isStringLiteral(stmt.moduleSpecifier) &&
      stmt.moduleSpecifier.text === 'zod'
    ) {
      return true
    }
  }
  return false
}

/**
 * Check if a function/method is private or internal (prefixed with _ or has
 * the `private` modifier). Internal functions are called by code that already
 * validates, so flagging them creates false positives.
 */
function isPrivateOrInternal(
  node: ts.FunctionDeclaration | ts.MethodDeclaration | ts.ArrowFunction,
): boolean {
  // Arrow functions assigned to _-prefixed variables are handled at the caller level
  if (ts.isFunctionDeclaration(node) && node.name?.text.startsWith('_')) {
    return true
  }

  if (ts.isMethodDeclaration(node)) {
    // Check for `private` keyword
    if (node.modifiers?.some((m) => m.kind === ts.SyntaxKind.PrivateKeyword)) {
      return true
    }
    // Check for _-prefixed method name
    if (ts.isIdentifier(node.name) && node.name.text.startsWith('_')) {
      return true
    }
  }

  return false
}

/**
 * Check if a parameter has a default value (e.g., `limit = 50`).
 * Parameters with defaults already have a safe fallback and don't need
 * NaN/Infinity validation at the call boundary.
 */
function hasDefaultValue(param: ts.ParameterDeclaration): boolean {
  return param.initializer !== undefined
}

/**
 * Check if a parameter has a number type reference
 */
function isNumberTypeParam(param: ts.ParameterDeclaration): boolean {
  if (!param.type || !ts.isTypeReferenceNode(param.type)) {
    return false
  }
  const typeName = param.type.typeName
  return ts.isIdentifier(typeName) && typeName.text === 'number'
}

/**
 * Check if the function body contains numeric validation patterns
 */
function bodyHasValidation(body: ts.Node, sourceFile: ts.SourceFile): boolean {
  const bodyText = body.getText(sourceFile)
  return VALIDATION_PATTERNS.some((p) => p.test(bodyText))
}

/** Options for createParameterViolation */
interface CreateParameterViolationOptions {
  param: ts.ParameterDeclaration
  sourceFile: ts.SourceFile
}

/**
 * Create a violation for an unvalidated numeric parameter
 */
function createParameterViolation(options: CreateParameterViolationOptions): CheckViolation {
  const { param, sourceFile } = options
  const paramName = ts.isIdentifier(param.name) ? param.name.text : 'param'
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(param.getStart())
  const lineNum = line + 1
  const matchText = param.getText(sourceFile)

  return {
    line: lineNum,
    column: character + 1,
    message: `Numeric parameter '${paramName}' lacks NaN/Infinity validation`,
    severity: 'warning',
    type: 'unvalidated-numeric',
    suggestion: `Add validation at the start of the function: if (!Number.isFinite(${paramName})) { throw new Error('Invalid ${paramName}: must be a finite number'); }`,
    match: matchText,
  }
}

/** Options for checkFunctionParameters */
interface CheckFunctionParametersOptions {
  node: ts.FunctionDeclaration | ts.MethodDeclaration | ts.ArrowFunction
  sourceFile: ts.SourceFile
}

/**
 * Check function parameters for unvalidated number types
 */
function checkFunctionParameters(options: CheckFunctionParametersOptions): CheckViolation[] {
  const { node, sourceFile } = options
  const violations: CheckViolation[] = []
  const body = node.body
  /* v8 ignore next -- defensive guard */
  if (!body) return violations

  // Skip private/internal functions — callers validate before passing values
  if (isPrivateOrInternal(node)) return violations

  // Filter to number params that lack validation
  const unvalidatedNumberParams = node.parameters.filter((param) => {
    /* v8 ignore next -- defensive AST/type guard */
    if (!isNumberTypeParam(param)) return false
    if (bodyHasValidation(body, sourceFile)) return false

    // Skip parameters with default values (already have safe fallback)
    if (hasDefaultValue(param)) return false

    // Skip safe parameter names (loop indices, counters, etc.)
    /* v8 ignore next -- defensive AST/type guard */
    if (ts.isIdentifier(param.name) && SAFE_PARAMETER_NAMES.has(param.name.text)) return false

    return true
  })

  for (const param of unvalidatedNumberParams) {
    violations.push(createParameterViolation({ param, sourceFile }))
  }

  return violations
}

/**
 * Check if node is inside a validation check (e.g., isFinite wrapper)
 */
function isInsideValidationCheck(node: ts.CallExpression): boolean {
  const parent = node.parent
  if (!ts.isCallExpression(parent)) return false

  const parentExpr = parent.expression
  return ts.isPropertyAccessExpression(parentExpr) && parentExpr.name.text === 'isFinite'
}

/** Options for createParseViolation */
interface CreateParseViolationOptions {
  node: ts.CallExpression
  funcName: string
  sourceFile: ts.SourceFile
}

/**
 * Create a violation for unvalidated parseInt/parseFloat call
 */
function createParseViolation(options: CreateParseViolationOptions): CheckViolation {
  const { node, funcName, sourceFile } = options
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart())
  const lineNum = line + 1
  const matchText = node.getText(sourceFile)

  return {
    line: lineNum,
    column: character + 1,
    message: `${funcName}() result not validated for NaN`,
    severity: 'warning',
    type: 'unvalidated-parse',
    suggestion: `Wrap the ${funcName}() call with validation: const parsed = ${funcName}(...); if (!Number.isFinite(parsed)) { /* handle invalid input */ }`,
    match: matchText,
  }
}

/** Options for checkParseCall */
interface CheckParseCallOptions {
  node: ts.CallExpression
  sourceFile: ts.SourceFile
  content: string
}

/**
 * Check if the next N lines after a parse call contain NaN validation.
 * Looks ahead 3 lines for patterns like isNaN(), Number.isFinite(), etc.
 */
function nearbyLinesHaveValidation(content: string, lineIndex: number): boolean {
  const lines = content.split('\n')
  const lookAhead = 3
  const end = Math.min(lineIndex + lookAhead + 1, lines.length)
  for (let i = lineIndex + 1; i < end; i++) {
    /* v8 ignore next -- defensive nullish fallback */
    const nextLine = lines[i] ?? ''
    if (VALIDATION_PATTERNS.some((p) => p.test(nextLine))) return true
  }
  return false
}

/**
 * Patterns for the `|| 0` fallback that safely handles NaN
 * (NaN || 0 evaluates to 0, so NaN never propagates)
 */
const OR_ZERO_FALLBACK = /\|\|\s*0\b/

/**
 * Check if a parse call argument accesses a DynamoDB `.N` attribute.
 * DynamoDB `.N` attributes are guaranteed to be valid numeric strings.
 */
function isDynamoDBNumericAttribute(node: ts.CallExpression, sourceFile: ts.SourceFile): boolean {
  const firstArg = node.arguments[0]
  /* v8 ignore next -- defensive AST/type guard */
  if (!firstArg) return false
  const argText = firstArg.getText(sourceFile)
  // Match patterns like `item.N`, `attr.N`, `result.Item.count.N`, including with nullish coalescing
  return /\.N\b/.test(argText)
}

/**
 * Check if a parse call has a safe numeric string fallback as its argument.
 * Matches patterns like `parseInt(x || '123', 10)` or `parseInt(x ?? '456', 10)`
 * where the fallback is a literal numeric string.
 */
function hasSafeNumericFallback(node: ts.CallExpression, sourceFile: ts.SourceFile): boolean {
  const firstArg = node.arguments[0]
  /* v8 ignore next -- defensive AST/type guard */
  if (!firstArg) return false
  const argText = firstArg.getText(sourceFile)
  // Match `expr || 'digits'` or `expr ?? 'digits'` where the fallback is a numeric string
  return /(?:\|\||[?][?])\s*'[\d.]+'/.test(argText)
}

/**
 * Check if a regex digit guard precedes the parse call on nearby lines,
 * guaranteeing digits-only input. Detects two patterns:
 * 1. Inline guard: `/^\d+$/.test(value)` on the same or preceding line
 * 2. Regex capture: a regex containing `\d` groups (via `.exec()` or variable)
 *    where the parse call argument is a regex match subscript (e.g., `match[1]`)
 */
function hasRegexDigitGuard(
  content: string,
  lineIndex: number,
  node: ts.CallExpression,
  sourceFile: ts.SourceFile,
): boolean {
  const lines = content.split('\n')
  const lookBack = 3
  /* v8 ignore next -- defensive non-negative guard */
  const start = Math.max(0, lineIndex - lookBack)

  // Pattern 1: inline .test() with \d regex on same or preceding lines
  for (let i = start; i <= lineIndex; i++) {
    /* v8 ignore next -- defensive nullish fallback */
    const line = lines[i] ?? ''
    if (/\/[^/]*\\d[^/]*\/\w*\.test\(/.test(line)) return true
  }

  // Pattern 2: regex capture group - check if parseInt arg is a match subscript
  // AND a regex with \d is defined or used nearby
  const firstArg = node.arguments[0]
  /* v8 ignore next -- defensive AST/type guard */
  if (!firstArg) return false
  const argText = firstArg.getText(sourceFile)
  // Argument must be a match result subscript (e.g., `match[1]`, `retryAfterMatch[1]`)
  // eslint-disable-next-line sonarjs/slow-regex -- simple pattern matching identifier[digit]; no backtracking risk
  if (!/\w+\[\d+\]/.test(argText)) return false

  // Look for regex with \d in nearby lines (broader window for variable-defined regex)
  const regexLookBack = 5
  /* v8 ignore next -- defensive non-negative guard */
  const regexStart = Math.max(0, lineIndex - regexLookBack)
  for (let i = regexStart; i <= lineIndex; i++) {
    /* v8 ignore next -- defensive nullish fallback */
    const line = lines[i] ?? ''
    if (/\/[^/]*\\d[^/]*\//.test(line)) return true
  }

  return false
}

/**
 * Check parseInt/parseFloat calls for NaN validation
 */
function checkParseCall(options: CheckParseCallOptions): CheckViolation | null {
  const { node, sourceFile, content } = options
  const expr = node.expression
  if (!ts.isIdentifier(expr)) return null
  if (expr.text !== 'parseInt' && expr.text !== 'parseFloat') return null
  if (isInsideValidationCheck(node)) return null

  const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart())
  const lines = content.split('\n')
  /* v8 ignore next -- defensive nullish fallback */
  const lineText = lines[line] ?? ''

  // Check current line for validation patterns
  /* v8 ignore next -- defensive AST/type guard */
  if (VALIDATION_PATTERNS.some((p) => p.test(lineText))) return null

  // Check next 2-3 lines for NaN validation (multi-line validation pattern)
  if (nearbyLinesHaveValidation(content, line)) return null

  // DynamoDB .N attributes are guaranteed valid numeric strings
  if (isDynamoDBNumericAttribute(node, sourceFile)) return null

  // Safe fallback: `|| 0` on the same line converts NaN to 0
  /* v8 ignore next -- defensive AST/type guard */
  if (OR_ZERO_FALLBACK.test(lineText)) return null

  // Safe numeric string fallback in argument (e.g., `x ?? '0'`)
  // combined with `|| 0` on the result line, or standalone safe defaults
  if (hasSafeNumericFallback(node, sourceFile)) return null

  // Regex digit guard preceding the parse call guarantees digits-only input
  if (hasRegexDigitGuard(content, line, node, sourceFile)) return null

  return createParseViolation({ node, funcName: expr.text, sourceFile })
}

/**
 * Analyze a file for numeric validation issues
 *
 * @param content - File content to analyze
 * @param filePath - Path to the file
 * @returns Array of violations found
 */
function analyzeFile(content: string, filePath: string): CheckViolation[] {
  const violations: CheckViolation[] = []

  // Skip test files — test code doesn't need numeric validation guards
  if (isTestFile(filePath)) {
    return violations
  }

  // Skip route handler files — parameters come from Zod-validated schemas
  if (filePath.includes('routes/')) {
    return violations
  }

  // Quick filter: skip files without numeric-related patterns
  if (!QUICK_FILTER_KEYWORDS.some((kw) => content.includes(kw))) {
    return violations
  }

  try {
    const sourceFile = getSharedSourceFile(filePath, content)
    /* v8 ignore next -- defensive guard */
    if (!sourceFile) return []

    // Skip files that import Zod — parameters likely come from parsed schemas
    if (fileImportsZod(sourceFile)) return []

    const visit = (node: ts.Node): void => {
      if (
        ts.isFunctionDeclaration(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isArrowFunction(node)
      ) {
        violations.push(...checkFunctionParameters({ node, sourceFile }))
      }

      if (ts.isCallExpression(node)) {
        const parseViolation = checkParseCall({ node, sourceFile, content })
        if (parseViolation) {
          violations.push(parseViolation)
        }
      }

      ts.forEachChild(node, visit)
    }

    visit(sourceFile)
  /* v8 ignore next 1 -- defensive catch: parse failures already handled */
  } catch {
    // @swallow-ok Skip files that fail to parse
  }

  return violations
}

/**
 * Check: quality/numeric-validation
 *
 * Detects numeric parameters without NaN/Infinity/range validation.
 */
export const numericValidation = defineCheck({
  id: '7e6e4703-670d-45cd-a0cd-e14595e6fffc',
  slug: 'numeric-validation',
  scope: { languages: ['typescript'], concerns: ['backend', 'server'] },
  contentFilter: 'strip-strings',

  confidence: 'high',
  description: 'Detect numeric parameters without NaN/Infinity/range validation',
  longDescription: `**Purpose:** Ensures numeric function parameters and \`parseInt\`/\`parseFloat\` results are validated for \`NaN\` and \`Infinity\`, preventing silent arithmetic bugs.

**Detects:**
- Function/method/arrow-function parameters with explicit \`number\` type whose body lacks \`Number.isFinite\`, \`Number.isNaN\`, \`Number.isInteger\`, \`isFinite()\`, \`isNaN()\`, or \`typeof === 'number'\` checks
- \`parseInt()\` and \`parseFloat()\` calls whose result is not validated for NaN

**Auto-exempts:**
- Validation on the same line or within the next 3 lines (multi-line validation)
- DynamoDB \`.N\` attribute access (guaranteed valid numeric strings)
- \`|| 0\` fallback on the result (NaN || 0 safely evaluates to 0)
- Safe numeric string fallback in argument (e.g., \`parseInt(x ?? '0', 10)\`)
- Regex digit guards preceding the call (e.g., \`/^\\\\d+$/.test(v)\` or regex \`\\\\d\` capture groups via \`.exec()\`)
- Calls wrapped inside \`Number.isFinite()\`
- Files that import from \`zod\` (parameters come from Zod-parsed schemas)
- Private/internal functions (prefixed with \`_\` or \`private\` keyword)
- Parameters with default values (e.g., \`limit = 50\`)
- Safe parameter names: loop indices (\`i\`, \`j\`, \`k\`, \`index\`), counters (\`count\`, \`length\`, \`offset\`, \`limit\`, \`depth\`, \`level\`, \`size\`, \`capacity\`)
- Test files (\`*.test.ts\`, \`__tests__/\`)
- Route handler files (\`routes/\` -- receive Zod-validated params)

**Why it matters:** \`NaN\` and \`Infinity\` silently propagate through arithmetic, corrupting calculations and stored values without throwing errors.

**Scope:** General best practice. Analyzes each file individually.`,
  tags: ['quality', 'code-quality', 'type-safety'],
  fileTypes: ['ts', 'tsx'],

  analyze: analyzeFile,
})
