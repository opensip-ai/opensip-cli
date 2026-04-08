/**
 * @fileoverview Detect potential SQL injection vulnerabilities
 *
 * Uses AST analysis to find SQL injection patterns in template literals and
 * string concatenation. AST context eliminates false positives from suggestion
 * text, error messages, and comments.
 */

import {
  defineCheck,
  type CheckViolation,
  parseSource,
  walkNodes,
  getASTLineNumber,
  ts,
} from '@opensip-tools/core'

/**
 * SQL structural patterns indicating actual SQL statements (not casual English).
 * Requires SQL keyword + structural follow-up: SELECT...FROM, INSERT INTO, etc.
 */
const SQL_STRUCTURE_PATTERN =
  /\b(?:SELECT\s+[\w.*]+\s+FROM|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|DROP\s+(?:TABLE|INDEX|DATABASE|VIEW)|ALTER\s+TABLE|CREATE\s+(?:TABLE|INDEX|DATABASE|VIEW)|TRUNCATE\s+(?:TABLE)?)\b/i

/** Simpler pattern for SQL keywords at start of string concatenation */
const SQL_KEYWORD_PATTERN = /^\s*(?:SELECT|INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE)\b/i

/** SQL clause keywords for detecting concatenation in WHERE/SET/VALUES clauses */
const SQL_CLAUSE_PATTERN = /\b(?:WHERE|AND|OR|SET|VALUES)\b/i

/** Safe tagged template tags that use parameterized queries */
const SAFE_TEMPLATE_TAGS = new Set(['sql', 'query', 'raw'])

/** Safe object property names where SQL-like words are just messages */
const SUGGESTION_PROPERTY_NAMES = new Set([
  'message',
  'msg',
  'suggestion',
  'description',
  'help',
  'hint',
  'detail',
  'title',
  'label',
  'text',
  'placeholder',
  'tooltip',
  'caption',
  'summary',
])

/**
 * Check if a template expression is inside a tagged template literal.
 * Tagged templates like sql`...` or db.query`...` use parameterized queries.
 */
function isInTaggedTemplate(node: ts.Node): boolean {
  let current = node.parent
  while (!ts.isSourceFile(current)) {
    if (ts.isTaggedTemplateExpression(current)) {
      const tag = current.tag
      if (ts.isIdentifier(tag) && SAFE_TEMPLATE_TAGS.has(tag.text)) return true
      if (ts.isPropertyAccessExpression(tag) && SAFE_TEMPLATE_TAGS.has(tag.name.text)) return true
      // Any tagged template is likely using parameterized queries
      return true
    }
    current = current.parent
  }
  return false
}

/**
 * Check if a node is inside an object literal property used for messages/suggestions.
 * Template literals in properties like { message: `...`, suggestion: `...` } are not SQL.
 */
function isInSuggestionProperty(node: ts.Node): boolean {
  let current = node.parent
  while (!ts.isSourceFile(current)) {
    if (
      ts.isPropertyAssignment(current) &&
      ts.isIdentifier(current.name) &&
      SUGGESTION_PROPERTY_NAMES.has(current.name.text.toLowerCase())
    ) {
      return true
    }
    current = current.parent
  }
  return false
}

/**
 * Check if a node is a direct argument to a .query() call.
 */
function isInQueryCall(node: ts.Node): boolean {
  const parent = node.parent
  return (
    ts.isCallExpression(parent) &&
    ts.isPropertyAccessExpression(parent.expression) &&
    parent.expression.name.text === 'query'
  )
}

/**
 * Get the full text content of a template expression (head + spans).
 */
function getTemplateText(node: ts.TemplateExpression): string {
  const parts: string[] = [node.head.text]
  for (const span of node.templateSpans) {
    // @fitness-ignore-next-line performance-anti-patterns -- string literal placeholder for template span, not a spread operator
    parts.push('${...}', span.literal.text)
  }
  return parts.join('')
}

/**
 * Check a template expression node for SQL injection via interpolation.
 */
function checkTemplateInjection(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  filePath: string,
  violations: CheckViolation[],
): void {
  if (!ts.isTemplateExpression(node)) return
  if (isInTaggedTemplate(node)) return
  if (isInSuggestionProperty(node)) return

  const templateText = getTemplateText(node)
  if (!SQL_STRUCTURE_PATTERN.test(templateText)) return

  const line = getASTLineNumber(node, sourceFile)
  const matchText = node.getText()
  const isQueryArg = isInQueryCall(node)

  violations.push({
    line,
    column: 0,
    message: isQueryArg
      ? 'Potential SQL injection: raw query with template interpolation'
      : 'Potential SQL injection: template literal with SQL and interpolation detected',
    severity: 'error',
    suggestion:
      'Use parameterized queries: db.query("SELECT * FROM users WHERE id = $1", [userId]). Never interpolate user input directly into SQL strings.',
    match: matchText.length > 200 ? matchText.slice(0, 200) + '...' : matchText,
    filePath,
  })
}

/**
 * Check a binary expression node for SQL injection via string concatenation.
 */
function checkConcatenationInjection(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  filePath: string,
  violations: CheckViolation[],
): void {
  if (!ts.isBinaryExpression(node)) return
  if (node.operatorToken.kind !== ts.SyntaxKind.PlusToken) return
  if (isInSuggestionProperty(node)) return

  const leftIsString = ts.isStringLiteral(node.left)
  const rightIsString = ts.isStringLiteral(node.right)
  if (!leftIsString && !rightIsString) return

  const leftText = leftIsString ? node.left.text : ''
  const rightText = rightIsString ? node.right.text : ''

  if (leftIsString && SQL_KEYWORD_PATTERN.test(leftText) && !rightIsString) {
    violations.push({
      line: getASTLineNumber(node, sourceFile),
      column: 0,
      message: 'Potential SQL injection: SQL string concatenation detected',
      severity: 'error',
      suggestion:
        'Use parameterized queries instead of string concatenation. With TypeORM: createQueryBuilder().where("id = :id", { id }). With raw queries: query("SELECT * FROM t WHERE x = $1", [x]).',
      match: node.getText(),
      filePath,
    })
  }

  if (rightIsString && SQL_CLAUSE_PATTERN.test(rightText) && !leftIsString) {
    violations.push({
      line: getASTLineNumber(node, sourceFile),
      column: 0,
      message: 'Potential SQL injection: string concatenation in SQL clause detected',
      severity: 'error',
      suggestion:
        'Use parameterized queries for all user-supplied values. Never concatenate strings to build WHERE, AND, OR, SET, or VALUES clauses.',
      match: node.getText(),
      filePath,
    })
  }
}

/**
 * Check: security/sql-injection
 *
 * Detects potential SQL injection vulnerabilities using AST analysis.
 * Walks template literals and string concatenation to find SQL patterns,
 * while filtering out suggestion text, messages, and tagged templates.
 */
export const sqlInjection = defineCheck({
  id: '73c198ff-3d68-4e9b-a2aa-9e5d511cd89c',
  slug: 'sql-injection',
  scope: { languages: ['typescript'], concerns: ['backend', 'server'] },
  contentFilter: 'code-only',
  description: 'Detect potential SQL injection vulnerabilities',
  longDescription: `**Purpose:** Detects potential SQL injection vulnerabilities by using AST analysis to find user-supplied values interpolated or concatenated into SQL strings.

**Detects:**
- Template literals containing SQL structure patterns (SELECT...FROM, INSERT INTO, UPDATE...SET, DELETE FROM, DROP, ALTER, CREATE, TRUNCATE) with \`\${...}\` interpolation — excluding safe tagged templates (\`sql\`, \`query\`, \`raw\`) and message/suggestion properties
- String concatenation starting with SQL keywords (\`"SELECT " + variable\`)
- String concatenation appending SQL clause keywords (\`variable + " WHERE ..."\`)

**Why it matters:** SQL injection remains a top web vulnerability (OWASP Top 10). A single unparameterized query can expose or destroy an entire database.

**Scope:** General best practice. Analyzes each file individually using TypeScript AST. Excludes migrations and seed files.`,
  tags: ['security', 'injection', 'sql', 'database'],
  fileTypes: ['ts'],
  confidence: 'high',

  analyze(content: string, filePath: string): CheckViolation[] {
    const sourceFile = parseSource(content, filePath)
    if (!sourceFile) return []

    const violations: CheckViolation[] = []

    walkNodes(sourceFile, (node) => {
      // @lazy-ok -- synchronous callback; no awaits in analyze(); "resolved async result" in suggestion text triggers false positive
      checkTemplateInjection(node, sourceFile, filePath, violations)
      checkConcatenationInjection(node, sourceFile, filePath, violations)
    })

    return violations
  },
})
