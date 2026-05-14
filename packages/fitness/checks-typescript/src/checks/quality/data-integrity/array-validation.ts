/**
 * @fileoverview Array Parameter Validation Check
 *
 * Detects array parameters without proper validation.
 * Ensures arrays are validated for length, type, and content before processing.
 *
 */


import { defineCheck, type CheckViolation } from '@opensip-tools/fitness'
import { getSharedSourceFile } from '@opensip-tools/lang-typescript'
import * as ts from 'typescript'

import { isTestFile } from '../../../utils/index.js'

/**
 * Quick filter keywords for array validation patterns
 */
const QUICK_FILTER_KEYWORDS = [
  '[]',
  'Array',
  'array',
  '.length',
  '.push',
  '.pop',
  '.map(',
  '.filter(',
]

/**
 * Paths where array validation requirements are relaxed
 */
const RELAXED_VALIDATION_PATHS = [
  /\/internal\//,
  /\/utils\//,
  /\/helpers\//,
  /\/cli\//,
  /\/scripts\//,
]

/**
 * Type patterns that indicate complex/nested types where validation is harder to detect
 */
const COMPLEX_TYPE_PATTERNS = [
  'Record<',
  'Map<',
  '=> ', // Function type
  ': (', // Function type with parens
  'Promise<', // Async wrappers
  'Observable<',
]

/**
 * Check whether a parameter's type is a top-level array type (e.g. `string[]`, `Array<T>`)
 * as opposed to an object/interface/intersection type that merely _contains_ array-typed
 * properties (e.g. `{ items: string[] }`, `Foo & { tags: string[] }`).
 *
 * This uses the TypeScript AST node kind rather than text matching, eliminating false
 * positives for object parameters whose nested properties happen to be arrays.
 */
function isTopLevelArrayType(typeNode: ts.TypeNode): boolean {
  // Direct array type: `string[]`, `Foo[]`
  if (ts.isArrayTypeNode(typeNode)) {
    return true
  }

  // Generic Array reference: `Array<string>`, `ReadonlyArray<Foo>`
  if (ts.isTypeReferenceNode(typeNode)) {
    const typeName = typeNode.typeName
    if (ts.isIdentifier(typeName)) {
      const name = typeName.text
      if (name === 'Array' || name === 'ReadonlyArray') {
        return true
      }
    }
  }

  // Union type: check if ALL branches are arrays (e.g. `string[] | number[]`)
  if (ts.isUnionTypeNode(typeNode)) {
    return typeNode.types.length > 0 && typeNode.types.every((t) => isTopLevelArrayType(t))
  }

  // Parenthesized type: unwrap `(string[])`
  if (ts.isParenthesizedTypeNode(typeNode)) {
    return isTopLevelArrayType(typeNode.type)
  }

  // Everything else (object literals, intersection types, type references to interfaces,
  // mapped types, conditional types, etc.) is NOT a top-level array even if the type
  // text contains `[]` in nested positions.
  return false
}

/**
 * Check if a file path is in a relaxed validation context
 */
function isRelaxedValidationPath(filePath: string): boolean {
  return RELAXED_VALIDATION_PATHS.some((pattern) => pattern.test(filePath))
}

/**
 * Check if a type is a complex nested type where validation detection is unreliable
 */
function isComplexNestedType(typeText: string): boolean {
  return COMPLEX_TYPE_PATTERNS.some((pattern) => typeText.includes(pattern))
}

/**
 * Check if node is a .length access on the parameter
 * @param node - The TypeScript AST node to check
 * @param paramName - The name of the parameter to check for
 * @param sourceFile - The TypeScript source file for text extraction
 * @returns True if the node is a .length access on the specified parameter
 */
function isLengthAccess(node: ts.Node, paramName: string, sourceFile: ts.SourceFile): boolean {
  if (!ts.isPropertyAccessExpression(node)) return false
  const objName = node.expression.getText(sourceFile)
  const propName = node.name.getText(sourceFile)
  return objName === paramName && propName === 'length'
}

/**
 * Check if node is an Array.isArray() call on the parameter
 * @param node - The TypeScript AST node to check
 * @param paramName - The name of the parameter to check for
 * @param sourceFile - The TypeScript source file for text extraction
 * @returns True if the node is an Array.isArray() call on the specified parameter
 */
function isArrayIsArrayCall(node: ts.Node, paramName: string, sourceFile: ts.SourceFile): boolean {
  if (!ts.isCallExpression(node)) return false
  const callText = node.expression.getText(sourceFile)
  if (callText !== 'Array.isArray') return false
  const arg = node.arguments[0]?.getText(sourceFile)
  return arg === paramName
}

/**
 * Check if node is a Zod schema validation call
 * @param node - The TypeScript AST node to check
 * @param sourceFile - The TypeScript source file for text extraction
 * @returns True if the node is a Zod .parse() or .safeParse() call
 */
function isZodValidationCall(node: ts.Node, sourceFile: ts.SourceFile): boolean {
  if (!ts.isCallExpression(node)) return false
  if (!ts.isPropertyAccessExpression(node.expression)) return false
  const methodName = node.expression.name.getText(sourceFile)
  return methodName === 'parse' || methodName === 'safeParse'
}

/**
 * Check if node is a validation function call
 * @param node - The TypeScript AST node to check
 * @returns True if the node is a call to a function with 'validate' or 'check' in its name
 */
function isValidationFunctionCall(node: ts.Node): boolean {
  if (!ts.isCallExpression(node)) return false
  if (!ts.isIdentifier(node.expression)) return false
  const funcName = node.expression.text.toLowerCase()
  return funcName.includes('validate') || funcName.includes('check')
}

/**
 * Check if node is an iteration over the parameter (for...of, forEach, map, filter,
 * slice, includes, join, indexOf, concat, flat, etc.)
 *
 * Iteration implies validation because it handles empty arrays gracefully and
 * cannot blow up the runtime — the worst case is no work done.
 */
function isIterationOverParam(
  node: ts.Node,
  paramName: string,
  sourceFile: ts.SourceFile,
): boolean {
  // for...of statement
  if (ts.isForOfStatement(node)) {
    const iterableText = node.expression.getText(sourceFile)
    if (iterableText === paramName || iterableText.startsWith(`${paramName}.`)) {
      return true
    }
  }

  // Array prototype methods that internally iterate (and therefore handle empty
  // arrays gracefully) or otherwise produce a bounded view. These are
  // validation-equivalent because they don't crash on empty/short input.
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    const objText = node.expression.expression.getText(sourceFile)
    const methodName = node.expression.name.getText(sourceFile)
    const iterationMethods = [
      'forEach',
      'map',
      'filter',
      'some',
      'every',
      'find',
      'findIndex',
      'findLast',
      'findLastIndex',
      'reduce',
      'reduceRight',
      'flatMap',
      'flat',
      'slice',
      'includes',
      'indexOf',
      'lastIndexOf',
      'join',
      'concat',
      'entries',
      'values',
      'keys',
      'at',
      'toSorted',
      'toReversed',
      'toSpliced',
      'with',
    ]
    if (objText === paramName && iterationMethods.includes(methodName)) {
      return true
    }
  }

  return false
}

/**
 * Check if node is a write-only sink usage of the parameter.
 *
 * Out-array sinks (`bucket.push(...)`, `bucket.unshift(...)`) flag the param
 * as a producer target — the function isn't *consuming* the array, it's
 * writing into it. Validation belongs at the consumer, not the producer.
 */
function isOutSinkUsage(
  node: ts.Node,
  paramName: string,
  sourceFile: ts.SourceFile,
): boolean {
  if (!ts.isCallExpression(node)) return false
  if (!ts.isPropertyAccessExpression(node.expression)) return false
  const objText = node.expression.expression.getText(sourceFile)
  if (objText !== paramName) return false
  const methodName = node.expression.name.getText(sourceFile)
  // Mutating sink methods — caller is producing into the array.
  return methodName === 'push' || methodName === 'unshift' || methodName === 'splice'
}

/**
 * Check if node is indexed access on the parameter (`param[i]`).
 *
 * Indexed access on a typed array yields `T | undefined` under
 * `noUncheckedIndexedAccess`; under any reasonable consumer it implies
 * defensive use and cannot crash on empty/short input the way an
 * unconditional `.length`-less iteration would. Practically: if the body
 * does `param[i]`, the author has already structured the access around
 * length (or expects undefined).
 */
function isIndexedAccess(
  node: ts.Node,
  paramName: string,
  sourceFile: ts.SourceFile,
): boolean {
  if (!ts.isElementAccessExpression(node)) return false
  return node.expression.getText(sourceFile) === paramName
}

/**
 * Check if node is a spread of the parameter (`...param`) inside a call
 * argument list, array literal, or object literal.
 *
 * Spread iterates the array — equivalent to `for...of`.
 */
function isSpreadOfParam(
  node: ts.Node,
  paramName: string,
  sourceFile: ts.SourceFile,
): boolean {
  if (ts.isSpreadElement(node) || ts.isSpreadAssignment(node)) {
    return node.expression.getText(sourceFile) === paramName
  }
  return false
}

/**
 * Check if node passes the parameter through to another function call.
 *
 * A pure pass-through forwarder (`return otherFn(..., param, ...)`) defers
 * validation to the destination function — flagging the forwarder is a false
 * positive, since the wrapper has nothing to validate against. The destination
 * function (which actually consumes the array) is the meaningful validation
 * site.
 *
 * Restricted to call-argument position (not the callee position) so we don't
 * match the param being treated as a function.
 */
function isForwardedToCall(
  node: ts.Node,
  paramName: string,
  _sourceFile: ts.SourceFile,
): boolean {
  if (!ts.isCallExpression(node) && !ts.isNewExpression(node)) return false
  const args = node.arguments
  if (!args) return false
  for (const arg of args) {
    if (ts.isIdentifier(arg) && arg.text === paramName) {
      return true
    }
    // `Array.from(param)`, `[...param]`, etc. handled by isSpreadOfParam.
    // Type-cast forwards: `someFn(param as Foo)` or `someFn(param satisfies Foo)`.
    if (ts.isAsExpression(arg) || ts.isSatisfiesExpression(arg)) {
      const inner = arg.expression
      if (ts.isIdentifier(inner) && inner.text === paramName) {
        return true
      }
    }
  }
  return false
}

/**
 * Check if node is a property-shorthand reference to the parameter inside
 * an object literal (`return { param }`).
 *
 * The param value is being copied by reference into a result object — no
 * iteration, no boundary crossing, the consumer of the returned object is
 * the meaningful validation site (same logic as `isForwardedToCall`).
 */
function isShorthandPropertyReference(
  node: ts.Node,
  paramName: string,
): boolean {
  if (!ts.isShorthandPropertyAssignment(node)) return false
  return node.name.text === paramName
}

/**
 * Check if node is an optional chaining or nullish coalescing on the parameter
 */
function isOptionalHandling(node: ts.Node, paramName: string, sourceFile: ts.SourceFile): boolean {
  const nodeText = node.getText(sourceFile)
  // Optional chaining: param?.length, param?.map
  if (nodeText.includes(`${paramName}?.`)) {
    return true
  }
  // Nullish coalescing: param ?? []
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
  ) {
    const leftText = node.left.getText(sourceFile)
    if (leftText === paramName) {
      return true
    }
  }
  return false
}

/**
 * Check if function body contains array validation for the parameter
 * @param node - The function declaration, method, or arrow function node
 * @param param - The parameter declaration to check for validation
 * @param sourceFile - The TypeScript source file for text extraction
 * @returns True if the function body contains validation for the array parameter
 */
function checkForArrayValidation(
  node: ts.FunctionDeclaration | ts.MethodDeclaration | ts.ArrowFunction,
  param: ts.ParameterDeclaration,
  sourceFile: ts.SourceFile,
): boolean {
  if (!node.body) return false

  const paramName = ts.isIdentifier(param.name) ? param.name.text : null
  if (!paramName) return true // Destructured params are harder to track, assume validated

  // Underscore-prefixed params are an established TS convention for
  // "intentionally unused" — the body does not consume them, so demanding
  // validation is meaningless.
  if (paramName.startsWith('_')) return true

  let hasValidation = false

  const visit = (n: ts.Node) => {
    if (isLengthAccess(n, paramName, sourceFile)) {
      hasValidation = true
    }
    if (isArrayIsArrayCall(n, paramName, sourceFile)) {
      hasValidation = true
    }
    if (isZodValidationCall(n, sourceFile)) {
      hasValidation = true
    }
    if (isValidationFunctionCall(n)) {
      hasValidation = true
    }
    // Iteration patterns imply graceful handling of arrays
    if (isIterationOverParam(n, paramName, sourceFile)) {
      hasValidation = true
    }
    // Optional chaining/nullish coalescing implies null safety
    if (isOptionalHandling(n, paramName, sourceFile)) {
      hasValidation = true
    }
    // Out-array sinks (param.push(...)) — param is a producer target, not a
    // consumer input. Validation belongs at the consumer.
    if (isOutSinkUsage(n, paramName, sourceFile)) {
      hasValidation = true
    }
    // Indexed access (param[i]) — defensive, bounded by author intent.
    if (isIndexedAccess(n, paramName, sourceFile)) {
      hasValidation = true
    }
    // Spread (...param) — iterates the array, equivalent to for...of.
    if (isSpreadOfParam(n, paramName, sourceFile)) {
      hasValidation = true
    }
    // Forwarded to another call — destination owns validation.
    if (isForwardedToCall(n, paramName, sourceFile)) {
      hasValidation = true
    }
    // Property-shorthand reference ({ param }) — pass-through into a result
    // object; consumer of the result owns validation.
    if (isShorthandPropertyReference(n, paramName)) {
      hasValidation = true
    }

    if (!hasValidation) {
      ts.forEachChild(n, visit)
    }
  }

  visit(node.body)
  return hasValidation
}

/**
 * Options for checking function array params
 */
interface CheckFunctionArrayParamsOptions {
  node: ts.FunctionDeclaration | ts.MethodDeclaration | ts.ArrowFunction
  sourceFile: ts.SourceFile
  absolutePath: string
}

/**
 * Check function parameters for unvalidated arrays
 * Note: Ignore directives are handled at the framework level in defineCheck()
 * @param {CheckFunctionArrayParamsOptions} options - The check options
 * @returns Array of violations
 */
function checkFunctionArrayParams(options: CheckFunctionArrayParamsOptions): CheckViolation[] {
  const { node, sourceFile, absolutePath } = options
  const violations: CheckViolation[] = []

  // Skip files in relaxed validation paths
  if (isRelaxedValidationPath(absolutePath)) {
    return violations
  }

  // Skip abstract methods (can't have validation in body)
  if (
    ts.isMethodDeclaration(node) &&
    node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AbstractKeyword)
  ) {
    return violations
  }

  // Filter to array parameters without validation
  const unvalidatedArrayParams = node.parameters.filter((param) => {
    if (!param.type) return false

    // Primary gate: use AST to determine if the parameter's type is a top-level
    // array type.  Object/interface/intersection types whose *properties* are
    // arrays will correctly return false here, eliminating the largest category
    // of false positives.
    if (!isTopLevelArrayType(param.type)) return false

    const typeText = param.type.getText(sourceFile)

    // Secondary gate: skip complex/nested types where validation detection is
    // unreliable (Map values, Record values, function types, Promises, etc.)
    if (isComplexNestedType(typeText)) return false

    return !checkForArrayValidation(node, param, sourceFile)
  })

  for (const param of unvalidatedArrayParams) {
    const paramName = ts.isIdentifier(param.name) ? param.name.text : '<destructured>'
    const { line: lineIdx, character } = sourceFile.getLineAndCharacterOfPosition(param.getStart())
    const line = lineIdx + 1

    const paramText = param.getText(sourceFile)

    violations.push({
      line,
      column: character + 1,
      message: `Array parameter '${paramName}' lacks validation`,
      severity: 'warning',
      suggestion: `Add validation for '${paramName}' array: check Array.isArray(), validate .length bounds, and/or use Zod schema for content validation`,
      type: 'missing-array-validation',
      match: paramText,
    })
  }

  return violations
}

/**
 * Analyze a file for array validation issues
 * @param content - The file content as a string
 * @param absolutePath - The absolute path to the file being analyzed
 * @returns Array of violations found in the file
 */
function analyzeFile(content: string, absolutePath: string): CheckViolation[] {
  const violations: CheckViolation[] = []

  // Quick filter: skip files without array-related patterns
  if (!QUICK_FILTER_KEYWORDS.some((kw) => content.includes(kw))) {
    return violations
  }

  // Note: Ignore directives are handled at the framework level in defineCheck()

  const sourceFile = getSharedSourceFile(absolutePath, content)
    if (!sourceFile) return []

  const visit = (node: ts.Node) => {
    // Check function parameters with array types
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isArrowFunction(node)
    ) {
      violations.push(...checkFunctionArrayParams({ node, sourceFile, absolutePath }))
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return violations
}

/**
 * Check: quality/array-validation
 *
 * Detects array parameters without proper validation to prevent
 * runtime errors from unvalidated array inputs.
 *
 */
export const arrayValidation = defineCheck({
  id: 'a9e0e70c-a4af-42e6-bbd7-4c87a72cb7d4',
  slug: 'array-validation',
  scope: { languages: ['typescript'], concerns: ['backend', 'server'] },
  contentFilter: 'strip-strings',

  confidence: 'high',
  description: 'Detect array parameters without proper validation',
  longDescription: `**Purpose:** Ensures function parameters with array types are validated before use, preventing runtime errors from malformed or unexpected array inputs.

**Detects:**
- Function/method/arrow-function parameters whose top-level type is an array (\`string[]\`, \`Array<T>\`) and whose body lacks validation
- Missing \`Array.isArray()\` checks, \`.length\` bounds checks, Zod \`.parse()\`/\`.safeParse()\` calls, or calls to functions named \`validate\`/\`check\`
- Uses TypeScript AST node kinds (not text matching) to distinguish true array parameters from object/interface/intersection types that merely contain array-typed properties
- Skips parameters with complex nested types (\`Record<\`, \`Map<\`, \`Promise<\`, function types)
- Excludes files under \`/internal/\`, \`/utils/\`, \`/helpers/\`, \`/cli/\`, \`/scripts/\`

**Why it matters:** Unvalidated arrays can cause silent data corruption, out-of-bounds errors, or type mismatches at runtime that TypeScript's type system alone cannot prevent.

**Scope:** General best practice. Analyzes each file individually.`,
  tags: ['quality', 'validation', 'type-safety', 'arrays'],
  fileTypes: ['ts'],

  analyze(content: string, filePath: string): CheckViolation[] {
    // Skip test files — array parameter validation in tests is low-risk due to controlled inputs
    if (isTestFile(filePath)) return []
    return analyzeFile(content, filePath)
  },
})
