/**
 * @fileoverview Dispose Pattern Completeness check
 *
 * Validates that classes implementing IDisposable properly clean up resources.
 * Ensures all subscriptions, connections, and resources are disposed.
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
 * Check if a class implements IDisposable or Disposable
 * @param node - The class declaration node
 * @returns True if class implements IDisposable
 */
function classImplementsDisposable(node: ts.ClassDeclaration): boolean {
  if (!node.heritageClauses) {
    return false;
  }

  return node.heritageClauses.some((clause) => {
    // @fitness-ignore-next-line unsafe-secret-comparison -- Comparing TypeScript AST syntax kind token, not a cryptographic token
    if (clause.token !== ts.SyntaxKind.ImplementsKeyword) {
      return false;
    }
    return clause.types.some(
      (type) =>
        ts.isIdentifier(type.expression) &&
        (type.expression.text === 'IDisposable' || type.expression.text === 'Disposable'),
    );
  });
}

/**
 * Find the dispose method in a class
 * @param node - The class declaration node
 * @returns The dispose method or undefined
 */
function findDisposeMethod(node: ts.ClassDeclaration): ts.MethodDeclaration | undefined {
  const member = node.members.find(
    (m) => ts.isMethodDeclaration(m) && ts.isIdentifier(m.name) && m.name.text === 'dispose',
  );
  return member as ts.MethodDeclaration | undefined;
}

/**
 * Create a violation for missing dispose method
 * @param ctx - Violation context
 * @param node - The class declaration node
 * @param className - The class name
 * @returns CheckViolation object
 */
function createMissingDisposeViolation(
  ctx: ViolationContext,
  node: ts.ClassDeclaration,
  className: string,
): CheckViolation {
  const { line: lineIdx, character } = ctx.sourceFile.getLineAndCharacterOfPosition(
    node.getStart(),
  );
  const line = lineIdx + 1;

  return {
    line,
    column: character + 1,
    message: `Class '${className}' implements IDisposable but has no dispose method`,
    severity: 'error',
    suggestion: `Add 'dispose(): void { /* cleanup subscriptions, connections, timers */ }' method to ${className}`,
    type: 'missing-dispose',
    match: className,
  };
}

/**
 * Create a violation for empty dispose method
 * @param ctx - Violation context
 * @param disposeMethod - The dispose method node
 * @param className - The class name
 * @returns CheckViolation object
 */
function createEmptyDisposeViolation(
  ctx: ViolationContext,
  disposeMethod: ts.MethodDeclaration,
  className: string,
): CheckViolation {
  const { line: lineIdx, character } = ctx.sourceFile.getLineAndCharacterOfPosition(
    disposeMethod.getStart(),
  );
  const line = lineIdx + 1;

  return {
    line,
    column: character + 1,
    message: `Class '${className}' has empty dispose method`,
    severity: 'warning',
    suggestion: `Add cleanup logic to dispose(): unsubscribe from subscriptions, close connections, clear timers`,
    type: 'empty-dispose',
    match: `${className}.dispose`,
  };
}

/**
 * Check if dispose method is empty
 * @param disposeMethod - The dispose method node
 * @returns True if the dispose method body is empty
 */
function isDisposeMethodEmpty(disposeMethod: ts.MethodDeclaration): boolean {
  const methodBody = disposeMethod.body;
  return Boolean(methodBody && ts.isBlock(methodBody) && methodBody.statements.length === 0);
}

/**
 * Check if a property is a subscription or listener field
 * @param member - The class member node
 * @returns True if the property is a subscription field
 */
function isSubscriptionField(member: ts.ClassElement): member is ts.PropertyDeclaration {
  if (!ts.isPropertyDeclaration(member) || !ts.isIdentifier(member.name)) {
    return false;
  }
  const nameLower = member.name.text.toLowerCase();
  return nameLower.includes('subscription') || nameLower.includes('listener');
}

/**
 * Create a violation for uncleaned subscription
 * @param ctx - Violation context
 * @param field - The property declaration node
 * @param fieldName - The field name
 * @returns CheckViolation object
 */
function createUncleanedSubscriptionViolation(
  ctx: ViolationContext,
  field: ts.PropertyDeclaration,
  fieldName: string,
): CheckViolation {
  const { line: lineIdx, character } = ctx.sourceFile.getLineAndCharacterOfPosition(
    field.getStart(),
  );
  const line = lineIdx + 1;

  return {
    line,
    column: character + 1,
    message: `Subscription '${fieldName}' not cleaned up in dispose()`,
    severity: 'warning',
    suggestion: `Add 'this.${fieldName}?.unsubscribe();' or 'this.${fieldName} = null;' in the dispose() method`,
    type: 'uncleaned-subscription',
    match: fieldName,
  };
}

/**
 * Check subscription fields for proper cleanup in dispose method
 * @param ctx - Violation context
 * @param node - The class declaration node
 * @param disposeMethod - The dispose method node
 * @returns Array of violations
 */
function checkSubscriptionFields(
  ctx: ViolationContext,
  node: ts.ClassDeclaration,
  disposeMethod: ts.MethodDeclaration,
): CheckViolation[] {
  const violations: CheckViolation[] = [];
  /* v8 ignore next -- defensive nullish fallback */
  const disposeBody = disposeMethod.body?.getText(ctx.sourceFile) ?? '';

  for (const member of node.members) {
    if (!isSubscriptionField(member)) {
      continue;
    }

    const fieldName = (member.name as ts.Identifier).text;
    if (!disposeBody.includes(fieldName)) {
      violations.push(createUncleanedSubscriptionViolation(ctx, member, fieldName));
    }
  }

  return violations;
}

/**
 * Analyze a class declaration for dispose pattern issues
 * @param ctx - Violation context
 * @param node - The class declaration node
 * @returns Array of violations
 */
function analyzeClassDeclaration(
  ctx: ViolationContext,
  node: ts.ClassDeclaration,
): CheckViolation[] {
  const violations: CheckViolation[] = [];

  if (!node.name || !classImplementsDisposable(node)) {
    return violations;
  }

  const className = node.name.text;
  const disposeMethod = findDisposeMethod(node);

  if (!disposeMethod) {
    violations.push(createMissingDisposeViolation(ctx, node, className));
    return violations;
  }

  if (isDisposeMethodEmpty(disposeMethod)) {
    violations.push(createEmptyDisposeViolation(ctx, disposeMethod, className));
  }

  violations.push(...checkSubscriptionFields(ctx, node, disposeMethod));

  return violations;
}

/**
 * Analyze a file for dispose pattern completeness
 * @param absolutePath - The file path
 * @param content - The file content
 * @returns Array of violations
 */
function analyzeFile(absolutePath: string, content: string): CheckViolation[] {
  const violations: CheckViolation[] = [];

  const sourceFile = getSharedSourceFile(absolutePath, content);
  /* v8 ignore next -- defensive guard */
  if (!sourceFile) return [];

  const ctx: ViolationContext = { absolutePath, content, sourceFile };

  const visit = (node: ts.Node) => {
    if (ts.isClassDeclaration(node)) {
      violations.push(...analyzeClassDeclaration(ctx, node));
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return violations;
}

/**
 * Check: quality/dispose-pattern-completeness
 *
 * Validates IDisposable implementations properly clean up resources.
 */
export const disposePatternCompleteness = defineCheck({
  id: 'f4b1e176-e276-45d5-8d75-c132d5b893d4',
  slug: 'dispose-pattern-completeness',
  scope: { languages: ['typescript'], concerns: ['backend', 'server'] },

  confidence: 'high',
  description: 'Validate IDisposable implementations clean up all resources',
  longDescription: `**Purpose:** Validates that classes implementing \`IDisposable\` or \`Disposable\` properly clean up all resources in their \`dispose()\` method.

**Detects:** Analyzes each file individually using TypeScript AST. Checks for:
- Classes implementing IDisposable/Disposable that have no \`dispose()\` method
- Classes with an empty \`dispose()\` method body
- Subscription/listener fields (properties containing "subscription" or "listener" in name) not referenced in the \`dispose()\` method body

**Why it matters:** Incomplete dispose implementations cause memory leaks, dangling subscriptions, and unclosed connections that degrade application stability over time.

**Scope:** General best practice`,
  tags: ['quality', 'resources', 'memory', 'dispose', 'cleanup'],
  fileTypes: ['ts'],

  analyze(content, filePath) {
    // Quick filter: skip files without dispose-related patterns
    const hasDisposePatterns =
      content.includes('dispose') ||
      content.includes('Disposable') ||
      content.includes('subscription') ||
      content.includes('unsubscribe');
    if (!hasDisposePatterns) {
      return [];
    }

    return analyzeFile(filePath, content);
  },
});
