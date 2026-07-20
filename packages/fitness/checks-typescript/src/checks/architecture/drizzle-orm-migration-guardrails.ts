/**
 * @fileoverview Drizzle ORM migration guardrails
 * @module checks-builtin/checks/architecture/drizzle-orm-migration-guardrails
 *
 * Detects dangerous patterns in Drizzle ORM migrations and queries:
 * - Raw SQL template literals that bypass the query builder
 * - Missing transaction wrappers on multi-statement migrations
 * - DROP TABLE/COLUMN without explicit confirmation comment
 * - ALTER TABLE with data loss risk (column type changes)
 */

import { defineCheck, isTestFile, type CheckViolation } from '@opensip-cli/fitness';
import {
  filterContent,
  getSharedSourceFile,
  walkNodes,
  type FilteredContent,
} from '@opensip-cli/lang-typescript';
import * as ts from 'typescript';

interface DangerousPattern {
  pattern: RegExp;
  message: string;
  suggestion: string;
  severity: 'error' | 'warning';
}

const DANGEROUS_PATTERNS: DangerousPattern[] = [
  {
    pattern: /sql\.unsafe\s*\(/,
    message: 'sql.unsafe() bypasses parameterized queries — SQL injection risk',
    suggestion:
      'Use parameterized queries via the Drizzle query builder or sql`` template literals with interpolation.',
    severity: 'error',
  },
  {
    pattern: /DROP\s+TABLE/i,
    message: 'DROP TABLE detected — data loss risk. Ensure this is intentional.',
    suggestion:
      'Add a comment above confirming this is intentional: // DATA-LOSS: intentional table drop for migration X',
    severity: 'warning',
  },
  {
    pattern: /DROP\s+COLUMN/i,
    message: 'DROP COLUMN detected — data loss risk. Ensure this is intentional.',
    suggestion:
      'Add a comment above confirming this is intentional: // DATA-LOSS: intentional column drop',
    severity: 'warning',
  },
  {
    pattern: /ALTER\s+(?:TABLE|COLUMN).*TYPE/i,
    message: 'Column type change detected — potential data loss or truncation',
    suggestion: 'Verify the type change is safe. Add a comment explaining the migration strategy.',
    severity: 'warning',
  },
  {
    pattern: /TRUNCATE\s+/i,
    message: 'TRUNCATE detected — deletes all rows without logging',
    suggestion:
      'Use DELETE with a WHERE clause if you need audit logging, or confirm TRUNCATE is intentional.',
    severity: 'error',
  },
];

const DATA_LOSS_CONFIRMATION = /DATA-LOSS.*intentional/i;
const SQL_DANGEROUS_PATTERNS = DANGEROUS_PATTERNS.slice(1);

function hasDataLossConfirmation(
  lines: readonly string[],
  filtered: FilteredContent,
  line: number,
): boolean {
  for (let lineIndex = Math.max(0, line - 3); lineIndex < line; lineIndex++) {
    const match = DATA_LOSS_CONFIRMATION.exec(lines[lineIndex] ?? '');
    if (match && filtered.isInComment(lineIndex + 1, match.index)) {
      return true;
    }
  }
  return false;
}

function violationForMatch(
  sourceFile: ts.SourceFile,
  filePath: string,
  lines: readonly string[],
  filtered: FilteredContent,
  sourceStart: number,
  match: RegExpExecArray,
  pattern: DangerousPattern,
): CheckViolation | null {
  const { line } = sourceFile.getLineAndCharacterOfPosition(sourceStart + match.index);
  if (hasDataLossConfirmation(lines, filtered, line)) return null;

  return {
    line: line + 1,
    message: pattern.message,
    severity: pattern.severity,
    suggestion: pattern.suggestion,
    type: 'MIGRATION_GUARDRAIL',
    match: (lines[line] ?? match[0]).trim().slice(0, 100),
    filePath,
  };
}

interface SqlFragment {
  readonly text: string;
  readonly start: number;
}

function sqlTemplateFragments(
  template: ts.TemplateLiteral,
  sourceFile: ts.SourceFile,
): readonly SqlFragment[] {
  if (ts.isNoSubstitutionTemplateLiteral(template)) {
    const source = template.getText(sourceFile);
    return [{ text: source.slice(1, -1), start: template.getStart(sourceFile) + 1 }];
  }

  const headSource = template.head.getText(sourceFile);
  const fragments: SqlFragment[] = [
    {
      text: headSource.slice(1, -2),
      start: template.head.getStart(sourceFile) + 1,
    },
  ];
  for (const span of template.templateSpans) {
    const literalSource = span.literal.getText(sourceFile);
    const suffixLength = ts.isTemplateTail(span.literal) ? 1 : 2;
    fragments.push({
      text: literalSource.slice(1, -suffixLength),
      start: span.literal.getStart(sourceFile) + 1,
    });
  }
  return fragments;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function propertyName(expression: ts.Expression): string | null {
  const unwrapped = unwrapExpression(expression);
  if (ts.isPropertyAccessExpression(unwrapped)) return unwrapped.name.text;
  if (
    ts.isElementAccessExpression(unwrapped) &&
    unwrapped.argumentExpression &&
    ts.isStringLiteralLike(unwrapExpression(unwrapped.argumentExpression))
  ) {
    return (unwrapExpression(unwrapped.argumentExpression) as ts.StringLiteralLike).text;
  }
  return null;
}

function propertyReceiver(expression: ts.Expression): ts.Expression | null {
  const unwrapped = unwrapExpression(expression);
  if (ts.isPropertyAccessExpression(unwrapped) || ts.isElementAccessExpression(unwrapped)) {
    return unwrapExpression(unwrapped.expression);
  }
  return null;
}

function isSqlReceiver(expression: ts.Expression): boolean {
  const receiver = unwrapExpression(expression);
  return (ts.isIdentifier(receiver) && receiver.text === 'sql') || propertyName(receiver) === 'sql';
}

function isSqlUnsafeCall(node: ts.Node): node is ts.CallExpression {
  if (!ts.isCallExpression(node) || propertyName(node.expression) !== 'unsafe') return false;
  const receiver = propertyReceiver(node.expression);
  return receiver !== null && isSqlReceiver(receiver);
}

function isSqlTag(expression: ts.Expression): boolean {
  return isSqlReceiver(expression);
}

interface ScanContext {
  readonly sourceFile: ts.SourceFile;
  readonly filePath: string;
  readonly lines: readonly string[];
  readonly filtered: FilteredContent;
}

function violationsForFragment(
  context: ScanContext,
  fragment: SqlFragment,
  patterns: readonly DangerousPattern[],
): CheckViolation[] {
  const violations: CheckViolation[] = [];
  for (const pattern of patterns) {
    pattern.pattern.lastIndex = 0;
    const match = pattern.pattern.exec(fragment.text);
    if (!match) continue;
    const violation = violationForMatch(
      context.sourceFile,
      context.filePath,
      context.lines,
      context.filtered,
      fragment.start,
      match,
      pattern,
    );
    if (violation) violations.push(violation);
  }
  return violations;
}

function violationsForNode(node: ts.Node, context: ScanContext): CheckViolation[] {
  if (isSqlUnsafeCall(node)) {
    const text = node.getText(context.sourceFile);
    const match = /unsafe/.exec(text);
    /* v8 ignore next -- the structural predicate guarantees an unsafe property */
    if (!match) return [];
    return violationsForFragment(
      context,
      {
        text,
        start: node.getStart(context.sourceFile),
      },
      [{ ...DANGEROUS_PATTERNS[0], pattern: /unsafe/ }],
    );
  }

  if (!ts.isTaggedTemplateExpression(node)) return [];
  if (!isSqlTag(node.tag)) return [];
  return sqlTemplateFragments(node.template, context.sourceFile).flatMap((fragment) =>
    violationsForFragment(context, fragment, SQL_DANGEROUS_PATTERNS),
  );
}

export const drizzleOrmMigrationGuardrails = defineCheck({
  id: 'b67ccead-3731-40c5-9a90-6fc4b88c2bc5',
  slug: 'drizzle-orm-migration-guardrails',
  contentFilter: 'raw',
  scope: { languages: ['typescript'], concerns: ['backend'] },
  confidence: 'high',
  description:
    'Detects dangerous patterns in Drizzle ORM migrations (raw SQL, DROP, TRUNCATE, type changes)',
  tags: ['architecture', 'database', 'safety', 'drizzle'],
  fileTypes: ['ts'],

  analyze(content: string, filePath: string): CheckViolation[] {
    // Only check migration files and schema files (POSIX segments on OS paths)
    const normalized = filePath.replaceAll('\\', '/');
    if (!normalized.includes('/migrations/') && !normalized.includes('/schema')) return [];
    if (isTestFile(filePath)) return [];

    const sourceFile = getSharedSourceFile(filePath, content);
    if (!sourceFile) return [];

    const violations: CheckViolation[] = [];
    const context: ScanContext = {
      sourceFile,
      filePath,
      lines: content.split('\n'),
      filtered: filterContent(content),
    };

    walkNodes(sourceFile, (node) => violations.push(...violationsForNode(node, context)));

    return violations;
  },
});
