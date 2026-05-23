// @fitness-ignore-file no-generic-error -- Generic errors appropriate in this context
/**
 * @fileoverview Detect unsanitized user input usage
 *
 * Uses AST analysis to detect unsanitized user input in HTML injection,
 * command injection, and path traversal contexts. AST context eliminates
 * false positives from regex definitions, string constants, and comments.
 *
 *
 */

import { defineCheck, type CheckViolation, getASTLineNumber } from '@opensip-tools/fitness'
import { parseSource, walkNodes } from '@opensip-tools/lang-typescript'
import * as ts from 'typescript'

/** Names of user input sources on request objects */
const USER_INPUT_PROPERTIES = new Set(['body', 'params', 'query'])

/** Names of request objects */
const REQUEST_OBJECT_NAMES = new Set(['request', 'req'])

/** Dangerous command execution function names */
const EXEC_FUNCTIONS = new Set([
  'exec',
  'execSync',
  'spawn',
  'spawnSync',
  'execFile',
  'execFileSync',
])

/** Dangerous file system function names */
const FS_FUNCTIONS = new Set([
  'readFile',
  'readFileSync',
  'writeFile',
  'writeFileSync',
  'unlink',
  'unlinkSync',
  'rmdir',
  'rmdirSync',
  'mkdir',
  'mkdirSync',
])

/**
 * Check if an expression tree references user input (req.body, req.params, req.query).
 * Walks the subtree of the given node looking for property access chains like
 * `request.body.field` or `req.query.param`.
 */
function referencesUserInput(node: ts.Node): boolean {
  if (ts.isPropertyAccessExpression(node)) {
    // Check for req.body, req.params, req.query
    if (
      USER_INPUT_PROPERTIES.has(node.name.text) &&
      ts.isIdentifier(node.expression) &&
      REQUEST_OBJECT_NAMES.has(node.expression.text)
    ) {
      return true
    }
    // Check for deeper access: req.body.field
    if (ts.isPropertyAccessExpression(node.expression)) {
      return referencesUserInput(node.expression)
    }
  }

  // Check children
  let found = false
  ts.forEachChild(node, (child) => {
    if (!found && referencesUserInput(child)) {
      found = true
    }
  })
  return found
}

/**
 * Check if a node is inside a string literal or regex definition,
 * which would indicate this is a pattern definition, not actual code.
 */
function isInStringOrRegex(node: ts.Node): boolean {
  let current = node.parent
  while (!ts.isSourceFile(current)) {
    if (ts.isStringLiteral(current) || ts.isRegularExpressionLiteral(current)) return true
    if (ts.isNoSubstitutionTemplateLiteral(current)) return true
    current = current.parent
  }
  return false
}

function truncateMatch(node: ts.Node, maxLength = 200): string {
  const text = node.getText()
  return text.length > maxLength ? text.slice(0, maxLength) + '...' : text
}

function checkInnerHtmlAssignment(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  filePath: string,
): CheckViolation | null {
  if (
    ts.isBinaryExpression(node) &&
    (node.operatorToken.kind === ts.SyntaxKind.EqualsToken ||
      node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken) &&
    ts.isPropertyAccessExpression(node.left) &&
    node.left.name.text === 'innerHTML' &&
    referencesUserInput(node.right)
  ) {
    return {
      line: getASTLineNumber(node, sourceFile),
      column: 0,
      message: 'innerHTML with potential user input - use textContent or sanitize',
      severity: 'error',
      suggestion:
        'Use textContent for plain text: element.textContent = userInput. For HTML, use DOMPurify: element.innerHTML = DOMPurify.sanitize(userInput);',
      match: node.getText(),
      filePath,
    }
  }
  return null
}

function checkDangerouslySetInnerHTML(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  filePath: string,
): CheckViolation | null {
  if (
    ts.isJsxAttribute(node) &&
    ts.isIdentifier(node.name) &&
    node.name.text === 'dangerouslySetInnerHTML'
  ) {
    return {
      line: getASTLineNumber(node, sourceFile),
      column: 0,
      message: 'dangerouslySetInnerHTML usage - ensure input is sanitized',
      severity: 'warning',
      suggestion:
        'Sanitize content before using dangerouslySetInnerHTML: dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(content) }}. Consider using markdown renderers with XSS protection.',
      match: node.getText(),
      filePath,
    }
  }
  return null
}

function getCallFunctionName(node: ts.CallExpression): string {
  const callee = node.expression
  if (ts.isIdentifier(callee)) return callee.text
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text
  return ''
}

function checkUnsanitizedCallArgs(
  node: ts.CallExpression,
  sourceFile: ts.SourceFile,
  filePath: string,
  functionNames: Set<string>,
  message: string,
  suggestion: string,
): CheckViolation | null {
  const functionName = getCallFunctionName(node)
  if (!functionNames.has(functionName)) return null
  if (isInStringOrRegex(node)) return null
  for (const arg of node.arguments) {
    if (referencesUserInput(arg)) {
      return {
        line: getASTLineNumber(node, sourceFile),
        column: 0,
        message,
        severity: 'error',
        suggestion,
        match: truncateMatch(node),
        filePath,
      }
    }
  }
  return null
}

function checkHtmlTemplateInterpolation(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  filePath: string,
): CheckViolation | null {
  if (!ts.isTemplateExpression(node)) return null
  if (!/^\s*<[a-zA-Z]/.test(node.head.text)) return null
  for (const span of node.templateSpans) {
    if (referencesUserInput(span.expression)) {
      return {
        line: getASTLineNumber(node, sourceFile),
        column: 0,
        message: 'Unsanitized user input in HTML template - use html-escaper',
        severity: 'error',
        suggestion:
          'Use html-escaper or DOMPurify to sanitize user input before inserting into HTML: import { escape } from "html-escaper"; const safeHtml = escape(userInput);',
        match: truncateMatch(node),
        filePath,
      }
    }
  }
  return null
}

/**
 * Check: security/input-sanitization
 *
 * Detects user input used without proper sanitization using AST analysis.
 * Walks the AST to find actual innerHTML assignments, exec/spawn calls,
 * and file operations with user input references.
 *
 *
 */
export const inputSanitization = defineCheck({
  id: '31ef5173-a102-4a37-bc14-3f5bb08f9688',
  slug: 'input-sanitization',
  scope: { languages: ['typescript'], concerns: ['backend', 'server'] },
  contentFilter: 'strip-strings',
  description: 'Detect unsanitized user input usage',
  longDescription: `**Purpose:** Detects user input from request objects (req.body, req.params, req.query) flowing unsanitized into dangerous sinks, using AST analysis to avoid false positives.

**Detects:**
- innerHTML assignments with user input: \`element.innerHTML = req.body.content\`
- \`dangerouslySetInnerHTML\` JSX attribute usage
- User input passed to shell commands: \`exec()\`, \`execSync()\`, \`spawn()\`, \`spawnSync()\`, \`execFile()\`, \`execFileSync()\`
- User input in file system operations: \`readFile()\`, \`writeFile()\`, \`unlink()\`, etc. (path traversal)
- User input interpolated into HTML template literals: \`\`<div>\${req.body.name}</div>\`\`

**Why it matters:** Unsanitized user input leads to XSS, command injection, and path traversal vulnerabilities. AST-level detection catches real data flow issues while ignoring string constants and comments.

**Scope:** General best practice. Analyzes each file individually using TypeScript AST.`,
  tags: ['security', 'injection', 'sanitization'],
  fileTypes: ['ts'],
  confidence: 'high',

  analyze(content: string, filePath: string): CheckViolation[] {
    const sourceFile = parseSource(content, filePath)
    if (!sourceFile) return []

    const violations: CheckViolation[] = []

    walkNodes(sourceFile, (node) => {
      const innerHtml = checkInnerHtmlAssignment(node, sourceFile, filePath)
      if (innerHtml) {
        violations.push(innerHtml)
        return
      }

      const dangerousHtml = checkDangerouslySetInnerHTML(node, sourceFile, filePath)
      if (dangerousHtml) {
        violations.push(dangerousHtml)
        return
      }

      if (ts.isCallExpression(node)) {
        const cmdInjection = checkUnsanitizedCallArgs(
          node,
          sourceFile,
          filePath,
          EXEC_FUNCTIONS,
          'User input passed to shell command - potential command injection',
          'Never pass user input directly to shell commands. Use execFile with separate arguments array, or validate input against a strict allowlist. Consider using child_process.spawn with shell: false.',
        )
        if (cmdInjection) {
          violations.push(cmdInjection)
          return
        }

        const pathTraversal = checkUnsanitizedCallArgs(
          node,
          sourceFile,
          filePath,
          FS_FUNCTIONS,
          'User input in file path - potential path traversal vulnerability',
          'Validate file paths with path.resolve and ensure they stay within allowed directories: const safePath = path.resolve(baseDir, userInput); if (!safePath.startsWith(baseDir)) throw new Error("Invalid path");',
        )
        if (pathTraversal) {
          violations.push(pathTraversal)
          return
        }
      }

      const htmlTemplate = checkHtmlTemplateInterpolation(node, sourceFile, filePath)
      if (htmlTemplate) {
        violations.push(htmlTemplate)
      }
    })

    return violations
  },
})
