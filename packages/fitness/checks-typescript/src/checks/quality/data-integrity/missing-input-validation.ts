/**
 * @fileoverview Missing Input Validation Check
 *
 * Detects API handlers and functions accepting external input without validation.
 */


import { defineCheck, type CheckViolation } from '@opensip-tools/fitness'
import { getSharedSourceFile } from '@opensip-tools/lang-typescript'
import * as ts from 'typescript'

import { createPathMatcher } from '../../../utils/index.js'

/**
 * Paths that should be excluded from validation check
 */
const EXCLUDED_PATH_SEGMENTS = [
  '/services/',
  '/service/',
  '/utils/',
  '/util/',
  '/helpers/',
  '/helper/',
  '/domain/',
  '/models/',
  '/model/',
  '/types/',
  '/type/',
  '/schemas/',
  '/schema/',
  '/lib/',
  '/core/',
  '/shared/',
  '/common/',
]

const isExcludedValidationPath = createPathMatcher(EXCLUDED_PATH_SEGMENTS)

type FunctionLike =
  | ts.FunctionDeclaration
  | ts.MethodDeclaration
  | ts.ArrowFunction
  | ts.FunctionExpression

/**
 * Quick filter regex for handler patterns
 */
const QUICK_FILTER_HANDLER_PATTERNS =
  /\b(req|request|res|response|reply|handler|Handler|route|Route|endpoint|Endpoint|controller|Controller)\b/

/**
 * Validation patterns
 */
const VALIDATION_PATTERNS = [
  /\.parse\s*\(/,
  /\.safeParse\s*\(/,
  /z\.\w+\(/,
  /Joi\.\w+/,
  /yup\.\w+/,
  /\.validate\s*\(/,
  /validator\./i,
  /assertValid/i,
]

/**
 * @param {*} node
 * @returns {*}
 * Get function name from node
 */
// @fitness-ignore-next-line duplicate-utility-functions -- Check-specific helper typed to FunctionLike; each fitness check defines its own variant for its node type
function getFunctionName(node: FunctionLike): string {
  /* v8 ignore next -- defensive AST/type guard */
  if (ts.isFunctionDeclaration(node) && node.name) return node.name.text
  /* v8 ignore next -- defensive AST/type guard */
  if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) return node.name.text
  /* v8 ignore next -- defensive AST/type guard */
  if (ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) {
    return node.parent.name.text
  }
  return 'anonymous'
}

/**
 * Check if function has API handler parameters
 */
function hasApiParams(params: ts.NodeArray<ts.ParameterDeclaration>): boolean {
  if (params.length < 2) return false

  const [firstParam, secondParam] = params
  /* v8 ignore next -- defensive AST/type guard */
  if (!firstParam || !secondParam) return false

  const firstName = ts.isIdentifier(firstParam.name) ? firstParam.name.text : ''
  const secondName = ts.isIdentifier(secondParam.name) ? secondParam.name.text : ''

  // Express: (req, res) or Fastify: (request, reply)
  return (
    (/^(req|request)$/i.test(firstName) && /^(res|response)$/i.test(secondName)) ||
    (/^request$/i.test(firstName) && /^reply$/i.test(secondName))
  )
}

/**
 * Check if function is an API handler
 */
function isApiHandler(node: FunctionLike): boolean {
  return hasApiParams(node.parameters)
}

/**
 * Check if function body has validation
 */
function hasValidation(node: FunctionLike, sourceFile: ts.SourceFile): boolean {
  /* v8 ignore next -- defensive guard */
  if (!node.body) return true // No body = nothing to validate

  const bodyText = node.body.getText(sourceFile)
  return VALIDATION_PATTERNS.some((pattern) => pattern.test(bodyText))
}

/**
 * Analyze a file for missing input validation
 */
function analyzeFile(content: string, filePath: string): CheckViolation[] {
  const violations: CheckViolation[] = []

  // Skip excluded paths
  if (isExcludedValidationPath(filePath)) {
    return violations
  }

  // Quick filter: skip files without handler patterns
  if (!QUICK_FILTER_HANDLER_PATTERNS.test(content)) {
    return violations
  }

  try {
    const sourceFile = getSharedSourceFile(filePath, content)
    /* v8 ignore next -- defensive guard */
    if (!sourceFile) return []

    const checkFunction = (node: FunctionLike): void => {
      if (!isApiHandler(node)) return

      const functionName = getFunctionName(node)
      /* v8 ignore next -- defensive AST/type guard */
      if (hasValidation(node, sourceFile)) return

      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart())

      violations.push({
        line: line + 1,
        message: `API handler '${functionName}' accepts external input without validation`,
        severity: 'warning',
        suggestion: 'Add input validation using Zod, Joi, or similar library',
        match: functionName,
        type: 'missing-validation',
      })
    }

    const visit = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
        checkFunction(node)
      }
      if (
        ts.isVariableDeclaration(node) &&
        node.initializer &&
        (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
      ) {
        checkFunction(node.initializer)
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
 * Check: quality/missing-input-validation
 *
 * Detects API handlers and functions accepting external input without validation.
 */
export const missingInputValidation = defineCheck({
  id: '25f2a9b6-be96-42a4-aa0d-3b00839784e3',
  slug: 'missing-input-validation',
  scope: { languages: ['typescript'], concerns: ['backend', 'server'] },
  contentFilter: 'strip-strings',

  confidence: 'high',
  description: 'Detect API handlers accepting external input without validation (Zod, Joi, etc.)',
  longDescription: `**Purpose:** Detects API route handlers that accept external input (request/response parameters) without any schema validation, ensuring all boundaries validate their inputs.

**Detects:**
- Functions with Express-style \`(req, res)\` or Fastify-style \`(request, reply)\` parameter signatures
- Handler bodies lacking validation calls: \`.parse()\`, \`.safeParse()\`, \`z.*\`, \`Joi.*\`, \`yup.*\`, \`.validate()\`, \`validator.*\`, or \`assertValid\`
- Excludes internal paths (\`/services/\`, \`/utils/\`, \`/helpers/\`, \`/domain/\`, \`/models/\`, \`/types/\`, \`/schemas/\`, \`/lib/\`, \`/core/\`, \`/shared/\`, \`/common/\`)

**Why it matters:** API handlers without input validation are vulnerable to injection attacks, type confusion, and malformed data propagating into the system.

**Scope:** General best practice. Analyzes each file individually.`,
  tags: ['quality', 'security', 'code-quality'],
  fileTypes: ['ts'],

  analyze: analyzeFile,
})
