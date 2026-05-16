/**
 * @fileoverview Detect potential SQL injection vulnerabilities
 *
 * Uses AST analysis to find SQL injection patterns in template literals and
 * string concatenation. AST context eliminates false positives from suggestion
 * text, error messages, and comments.
 */

import { defineCheck, type CheckViolation, parseSource, walkNodes, getASTLineNumber, ts } from '@opensip-tools/fitness'

/**
 * SQL structural patterns indicating actual SQL statements (not casual English).
 * Requires SQL keyword + structural follow-up: SELECT...FROM, INSERT INTO, etc.
 */
const SQL_STRUCTURE_PATTERN =
  // eslint-disable-next-line sonarjs/regex-complexity -- enumerates SQL DML/DDL shapes in a single bounded alternation; splitting fragments the rule's intent
  /\b(?:SELECT\s+[\w.*]+\s+FROM|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|DROP\s+(?:TABLE|INDEX|DATABASE|VIEW)|ALTER\s+TABLE|CREATE\s+(?:TABLE|INDEX|DATABASE|VIEW)|TRUNCATE\s+(?:TABLE)?)\b/i

/** Simpler pattern for SQL keywords at start of string concatenation */
const SQL_KEYWORD_PATTERN = /^\s*(?:SELECT|INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE)\b/i

/**
 * SQL clause keywords for detecting concatenation in WHERE/SET/VALUES clauses.
 *
 * Case-SENSITIVE intentionally — lowercase `and`, `or`, `set`, `values`,
 * `where` are extremely common English words and produce massive false-
 * positive rates against CLI help-text strings (`'Usage: ...\n' +
 * 'AND swapped into tenant.keys'`). Real SQL keyword usage in code is
 * conventionally uppercase; the few projects that lowercase them can
 * either uppercase or pragma per-site. (See checkConcatenationInjection
 * for the additional "walk the concat chain for a real SQL keyword"
 * filter that prevents arm-3 from firing on incidental WHERE/AND inside
 * non-SQL text.)
 */
const SQL_CLAUSE_PATTERN = /\b(?:WHERE|AND|OR|SET|VALUES)\b/

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
 * Walk the binary-`+` concat chain rooted at `node` and collect every
 * string-literal segment's text. Used by `checkConcatenationInjection`
 * to gate arm-3 — a right-side string containing a clause keyword
 * (WHERE/AND/OR/SET/VALUES) is only treated as SQL when the SAME
 * concatenation also has at least one segment that starts with a real
 * SQL statement keyword (SELECT/INSERT/...).
 *
 * Why this matters: without the gate, the loose right-side check
 * fires on `cli.info('Usage: ...\n' + 'AND continues here\n')` because
 * "AND" appears in English help text. The gate requires the same
 * concat chain to also contain a "SELECT * FROM" or similar real-SQL
 * fragment, which CLI help text never has.
 *
 * Walks both up (ancestor +) and down (descendant +) from `node` so a
 * mid-chain finding still sees the whole expression.
 */
function collectConcatChainStrings(node: ts.BinaryExpression): string[] {
  const strings: string[] = []
  // Walk up to the root of the contiguous + chain.
  let root: ts.Node = node
  while (
    ts.isBinaryExpression(root.parent) &&
    root.parent.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    root = root.parent
  }
  // Walk down collecting every string-literal leaf.
  function collect(n: ts.Node): void {
    if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.PlusToken
    ) {
      collect(n.left)
      collect(n.right)
      return
    }
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      strings.push(n.text)
    }
  }
  collect(root)
  return strings
}

/**
 * True iff the concat chain rooted at the parent of `node` contains
 * at least one string segment that starts with a real SQL keyword
 * (SELECT/INSERT/...). This is the "this is actually SQL" sanity check
 * for arm-3 of checkConcatenationInjection.
 */
function concatChainHasSqlKeyword(node: ts.BinaryExpression): boolean {
  for (const s of collectConcatChainStrings(node)) {
    if (SQL_KEYWORD_PATTERN.test(s)) return true
  }
  return false
}

/**
 * Known CLI-output property-access call patterns: `cli.info(...)`,
 * `cli.error(...)`, `console.log(...)`, `logger.warn(...)`, etc.
 * Binary-string-concat arguments to these calls are never SQL.
 */
const OUTPUT_METHOD_NAMES = new Set([
  'log', 'info', 'warn', 'error', 'debug', 'trace', 'fatal',
  'print', 'println', 'raw', 'write', 'writeln',
])

/**
 * True iff `node` is an argument (direct or wrapped) to an output-style
 * call expression (`cli.info(...)`, `console.log(...)`, `logger.warn(...)`).
 * These call sites carry user-facing text, not SQL — concatenation
 * inside them is help/status text composition.
 */
function isInOutputCall(node: ts.Node): boolean {
  let current = node.parent
  while (!ts.isSourceFile(current)) {
    if (ts.isCallExpression(current)) {
      const callee = current.expression
      return (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.name) &&
        OUTPUT_METHOD_NAMES.has(callee.name.text)
      )
    }
    current = current.parent
  }
  return false
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
  if (isInOutputCall(node)) return

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
  if (isInOutputCall(node)) return

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

  if (
    rightIsString &&
    SQL_CLAUSE_PATTERN.test(rightText) &&
    !leftIsString &&
    // Gate: the concat chain must also contain a real SQL keyword
    // somewhere (SELECT/INSERT/...). Without this, the loose clause
    // pattern fires on incidental WHERE/AND inside non-SQL text
    // (CLI help strings, error message composition, etc.).
    concatChainHasSqlKeyword(node)
  ) {
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
/**
 * Pure analysis function. Exported so unit tests can exercise the
 * detection logic without standing up the full Check framework
 * (defineCheck wraps `analyze` into an `execute` closure that
 * requires an ExecutionContext to invoke).
 */
export function analyzeSqlInjection(content: string, filePath: string): CheckViolation[] {
  const sourceFile = parseSource(content, filePath)
  if (!sourceFile) return []

  const violations: CheckViolation[] = []

  walkNodes(sourceFile, (node) => {
    // @lazy-ok -- synchronous callback; no awaits in analyze(); "resolved async result" in suggestion text triggers false positive
    checkTemplateInjection(node, sourceFile, filePath, violations)
    checkConcatenationInjection(node, sourceFile, filePath, violations)
  })

  return violations
}

export const sqlInjection = defineCheck({
  id: '73c198ff-3d68-4e9b-a2aa-9e5d511cd89c',
  slug: 'sql-injection',
  scope: { languages: ['typescript'], concerns: ['backend', 'server'] },
  contentFilter: 'strip-strings',
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
    return analyzeSqlInjection(content, filePath)
  },
})
