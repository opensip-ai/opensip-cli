// @fitness-ignore-file duplicate-implementation-detection -- similar patterns across diagnostic modules
/**
 * @fileoverview Database Index Coverage check
 *
 * Validates that database queries have appropriate indexes.
 * Detects queries that may cause full table scans.
 */

import { defineCheck, type CheckViolation } from '@opensip-cli/fitness';
import { getSharedSourceFile } from '@opensip-cli/lang-typescript';
import * as ts from 'typescript';

/**
 * Context for creating violations
 */
interface ViolationContext {
  absolutePath: string;
  content: string;
  sourceFile: ts.SourceFile;
}

/**
 * Create a violation object with common fields
 * @param ctx - Violation context
 * @param node - TypeScript node
 * @param props - Violation properties
 * @returns CheckViolation object
 */
function createViolation(
  ctx: ViolationContext,
  node: ts.Node,
  props: {
    message: string;
    suggestion: string;
    type: string;
    match: string;
  },
): CheckViolation {
  const { line: lineIdx, character } = ctx.sourceFile.getLineAndCharacterOfPosition(
    node.getStart(),
  );
  const line = lineIdx + 1;

  return {
    line,
    column: character + 1,
    message: props.message,
    severity: 'warning',
    suggestion: props.suggestion,
    type: props.type,
    match: props.match,
  };
}

/**
 * Check if file is a repository/database file
 */
function isRepositoryFile(filePath: string): boolean {
  return (
    filePath.includes('/repositories/') ||
    filePath.includes('/database/') ||
    filePath.includes('-repository.ts') ||
    filePath.includes('.repository.ts')
  );
}

/**
 * Check if a where clause references potentially unindexed columns
 * @param node - The CallExpression node
 * @param ctx - Violation context
 * @returns CheckViolation or null
 */
function checkFindOperationWhereClause(
  node: ts.CallExpression,
  ctx: ViolationContext,
): CheckViolation | null {
  const whereArg = node.arguments[0];
  if (!whereArg || !ts.isObjectLiteralExpression(whereArg)) {
    return null;
  }

  const whereClause = whereArg.properties.find(
    (p) => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'where',
  );

  if (!whereClause || !ts.isPropertyAssignment(whereClause)) {
    return null;
  }

  const potentialIssues = checkWhereClause(whereClause.initializer);
  if (potentialIssues.length === 0) {
    return null;
  }

  return createViolation(ctx, node, {
    message: `Query may use non-indexed columns: ${potentialIssues.join(', ')}`,
    suggestion: `Add database index for column(s) ${potentialIssues.join(', ')} or refactor query to use indexed columns like 'id', 'createdAt', or foreign keys`,
    type: 'potential-full-scan',
    match: node.getText(ctx.sourceFile).slice(0, 60),
  });
}

/**
 * Check for leading wildcard LIKE in query text
 * @param node - The CallExpression node
 * @param queryText - Lowercase query text
 * @param queryArg - The string literal argument
 * @param ctx - Violation context
 * @returns CheckViolation or null
 */
function checkLeadingWildcardLike(
  node: ts.CallExpression,
  queryText: string,
  queryArg: ts.StringLiteral,
  ctx: ViolationContext,
): CheckViolation | null {
  const hasLeadingWildcard = queryText.includes("like '%") || queryText.includes('like "%');
  if (!hasLeadingWildcard) {
    return null;
  }

  return createViolation(ctx, node, {
    message: 'Query uses LIKE with leading wildcard, cannot use index',
    suggestion:
      "Replace LIKE '%term%' with full-text search (OpenSearch) or use LIKE 'term%' (trailing wildcard only) to enable index usage",
    type: 'leading-wildcard-like',
    match: queryArg.text.slice(0, 60),
  });
}

/**
 * Check for unbounded SELECT * queries
 * @param node - The CallExpression node
 * @param queryText - Lowercase query text
 * @param queryArg - The string literal argument
 * @param ctx - Violation context
 * @returns CheckViolation or null
 */
function checkUnboundedSelect(
  node: ts.CallExpression,
  queryText: string,
  queryArg: ts.StringLiteral,
  ctx: ViolationContext,
): CheckViolation | null {
  const hasSelectStar = queryText.includes('select *');
  const hasBound = queryText.includes('limit') || queryText.includes('top');
  if (!hasSelectStar || hasBound) {
    return null;
  }

  return createViolation(ctx, node, {
    message: 'SELECT * without LIMIT may scan entire table',
    suggestion:
      "Add 'LIMIT n' clause to bound the result set, or select specific columns instead of '*'",
    type: 'unbounded-select',
    match: queryArg.text.slice(0, 60),
  });
}

/**
 * Check raw query methods for issues
 * @param node - The CallExpression node
 * @param ctx - Violation context
 * @returns Array of violations
 */
function checkRawQueryMethod(node: ts.CallExpression, ctx: ViolationContext): CheckViolation[] {
  const violations: CheckViolation[] = [];
  const queryArg = node.arguments[0];

  if (!queryArg || !ts.isStringLiteral(queryArg)) {
    return violations;
  }

  const queryText = queryArg.text.toLowerCase();

  const wildcardViolation = checkLeadingWildcardLike(node, queryText, queryArg, ctx);
  if (wildcardViolation) {
    violations.push(wildcardViolation);
  }

  const unboundedViolation = checkUnboundedSelect(node, queryText, queryArg, ctx);
  if (unboundedViolation) {
    violations.push(unboundedViolation);
  }

  return violations;
}

/**
 * Analyze a call expression for index coverage issues
 * @param node - The CallExpression node
 * @param ctx - Violation context
 * @returns Array of violations
 */
function analyzeCallExpression(node: ts.CallExpression, ctx: ViolationContext): CheckViolation[] {
  const violations: CheckViolation[] = [];

  /* v8 ignore next -- defensive AST/type guard */
  if (!ts.isPropertyAccessExpression(node.expression)) {
    return violations;
  }

  const methodName = node.expression.name.getText(ctx.sourceFile);
  const findMethods = ['find', 'findOne', 'findBy', 'findOneBy'];
  const rawQueryMethods = ['query', 'createQueryBuilder'];

  if (findMethods.includes(methodName)) {
    const violation = checkFindOperationWhereClause(node, ctx);
    if (violation) {
      violations.push(violation);
    }
  } else if (rawQueryMethods.includes(methodName)) {
    violations.push(...checkRawQueryMethod(node, ctx));
  } else {
    // Other method names - no index coverage check needed
  }

  return violations;
}

/**
 * Analyze a file for index coverage issues
 * @param content - The file content
 * @param absolutePath - The file path
 * @returns Array of violations
 */
function analyzeFile(content: string, absolutePath: string): CheckViolation[] {
  const violations: CheckViolation[] = [];

  // Filter to repository/database files
  if (!isRepositoryFile(absolutePath)) {
    return violations;
  }

  const sourceFile = getSharedSourceFile(absolutePath, content);
  /* v8 ignore next -- defensive guard */
  if (!sourceFile) return [];

  const ctx: ViolationContext = { absolutePath, content, sourceFile };

  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      violations.push(...analyzeCallExpression(node, ctx));
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return violations;
}

/**
 * Check where clause for potentially unindexed columns
 * @param node - The where clause node
 * @returns Array of potentially problematic column names
 */
function checkWhereClause(node: ts.Node): string[] {
  const potentialIssues: string[] = [];

  // Columns that are commonly not indexed and should be flagged
  const riskyColumns = ['description', 'notes', 'content', 'body', 'text', 'metadata'];

  if (!ts.isObjectLiteralExpression(node)) {
    return potentialIssues;
  }

  for (const prop of node.properties) {
    if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) {
      continue;
    }
    const columnName = prop.name.text.toLowerCase();
    if (riskyColumns.some((r) => columnName.includes(r))) {
      potentialIssues.push(prop.name.text);
    }
  }

  return potentialIssues;
}

/**
 * Check: quality/database-index-coverage
 *
 * Validates that database queries reference indexed columns
 * to prevent performance issues from full table scans.
 */
export const databaseIndexCoverage = defineCheck({
  id: '51b5848f-b260-44f0-83e6-ce42a776cd05',
  slug: 'database-index-coverage',
  scope: { languages: ['typescript'], concerns: ['backend', 'server'] },

  confidence: 'high',
  description: 'Validate database queries have appropriate indexes',
  longDescription: `**Purpose:** Validates that database queries in repository files reference indexed columns and avoid patterns that cause full table scans.

**Detects:**
- TypeORM \`find\`/\`findOne\`/\`findBy\`/\`findOneBy\` calls whose \`where\` clause references commonly unindexed columns (\`description\`, \`notes\`, \`content\`, \`body\`, \`text\`, \`metadata\`)
- Raw \`query\`/\`createQueryBuilder\` calls with \`LIKE '%...\` (leading wildcard) which cannot use indexes
- \`SELECT *\` without \`LIMIT\` or \`TOP\` clause, risking unbounded result sets
- Only scans files in \`/repositories/\`, \`/database/\`, or files named \`*-repository.ts\`/\`*.repository.ts\`

**Why it matters:** Queries on unindexed columns or with leading wildcards cause O(N) full table scans, degrading performance as data grows.

**Scope:** General best practice. Analyzes each file individually.`,
  tags: ['quality', 'database', 'performance', 'indexes'],
  fileTypes: ['ts'],

  analyze: analyzeFile,
});
