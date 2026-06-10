// @fitness-ignore-file batch-operation-limits -- iterates bounded collections (config entries, registry items, or small analysis results)
/**
 * @fileoverview Shared AST utilities for fitness checks.
 *
 * Common TypeScript AST operations for tree walking and node inspection.
 * Used by AST-based fitness checks. Lives in @opensip-tools/lang-typescript
 * so the dependency on `typescript` is isolated to the language pack.
 *
 * Source parsing lives in `./parse.ts` (TSX-aware). Function-scope helpers
 * (findEnclosingFunction, isInAsyncContext, etc.) live in `./function-scope.ts`
 * and are re-exported through the package barrel; do NOT add new
 * function-scope helpers to this file.
 */

import { getParseTree } from '@opensip-tools/core/languages/parse-cache.js';
import * as ts from 'typescript';

import { typescriptAdapter } from './adapter.js';

// =============================================================================
// SOURCE PARSING (cached)
// =============================================================================

/**
 * Cached parse — uses the language-aware parse cache via the registered
 * TS adapter. Falls back to a direct parse when no cache is active.
 */
export function getSharedSourceFile(filePath: string, content: string): ts.SourceFile | null {
  return getParseTree(typescriptAdapter, filePath, content);
}

// =============================================================================
// TREE WALKING
// =============================================================================

/**
 * Depth-first walk of every descendant of `root` (the root itself is
 * not visited — pass a SourceFile to walk an entire file, or any
 * non-SourceFile node to walk a subtree). If you need the root in the
 * visit callback, wrap with: `visitor(root); walkNodes(root, visitor)`.
 */
export function walkNodes(root: ts.Node, visitor: (node: ts.Node) => void): void {
  function visit(node: ts.Node): void {
    visitor(node);
    ts.forEachChild(node, visit);
  }
  ts.forEachChild(root, visit);
}

// =============================================================================
// NODE INSPECTION
// =============================================================================

/**
 * Get the leaf identifier text from an expression node.
 */
export function getIdentifierName(node: ts.Node): string {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  return '';
}

/**
 * Get the full dotted path of a property access chain.
 */
export function getPropertyChain(node: ts.Node): string {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) {
    return `${getPropertyChain(node.expression)}.${node.name.text}`;
  }
  return '';
}

/**
 * Get the 1-indexed line number for a node.
 */
export function getLineNumber(node: ts.Node, sourceFile: ts.SourceFile): number {
  const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
  return line + 1;
}

/**
 * Get the column number (0-indexed) for a node.
 */
export function getColumn(node: ts.Node, sourceFile: ts.SourceFile): number {
  const { character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
  return character;
}

/**
 * Check if a node is a property access matching a specific property name.
 */
export function isPropertyAccess(node: ts.Node, propertyName: string): boolean {
  return ts.isPropertyAccessExpression(node) && node.name.text === propertyName;
}

/**
 * Check if a node is a literal value.
 */
export function isLiteral(node: ts.Node): boolean {
  if (ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return true;
  if (ts.isNoSubstitutionTemplateLiteral(node)) return true;
  if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword)
    return true;
  if (node.kind === ts.SyntaxKind.NullKeyword) return true;
  if (ts.isIdentifier(node) && node.text === 'undefined') return true;
  return false;
}

/**
 * Check if a node is inside a string literal or template literal.
 */
export function isInStringLiteral(node: ts.Node): boolean {
  let current = node.parent;
  while (!ts.isSourceFile(current)) {
    if (
      ts.isStringLiteral(current) ||
      ts.isNoSubstitutionTemplateLiteral(current) ||
      ts.isTemplateExpression(current)
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

// =============================================================================
// NODE FINDERS
// =============================================================================

/**
 * Find all call expressions matching `object.method()` pattern.
 */
export function findCallExpressions(
  root: ts.Node,
  objectName: string,
  methodName: string,
): ts.CallExpression[] {
  const results: ts.CallExpression[] = [];
  walkNodes(root, (node) => {
    if (!ts.isCallExpression(node)) return;
    const expr = node.expression;
    if (!ts.isPropertyAccessExpression(expr)) return;
    if (expr.name.text !== methodName) return;
    const chain = getPropertyChain(expr.expression);
    if (chain === objectName || chain.endsWith(`.${objectName}`)) {
      results.push(node);
    }
  });
  return results;
}

/**
 * Find all binary expressions with a specific operator.
 */
export function findBinaryExpressions(
  root: ts.Node,
  operator: ts.SyntaxKind,
): ts.BinaryExpression[] {
  const results: ts.BinaryExpression[] = [];
  walkNodes(root, (node) => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === operator) {
      results.push(node);
    }
  });
  return results;
}

/**
 * Find all template literal expressions (with substitutions).
 */
export function findTemplateLiterals(root: ts.Node): ts.TemplateExpression[] {
  const results: ts.TemplateExpression[] = [];
  walkNodes(root, (node) => {
    if (ts.isTemplateExpression(node)) {
      results.push(node);
    }
  });
  return results;
}

// =============================================================================
// COMMENT DETECTION
// =============================================================================

function isPositionInRanges(position: number, ranges: ts.CommentRange[] | undefined): boolean {
  if (!ranges) return false;
  for (const range of ranges) {
    if (position >= range.pos && position < range.end) return true;
  }
  return false;
}

/**
 * Check if a position in the source falls inside a comment.
 */
export function isInComment(position: number, sourceFile: ts.SourceFile): boolean {
  const text = sourceFile.getFullText();
  const lineStarts = sourceFile.getLineStarts();

  for (let i = 0; i < lineStarts.length; i++) {
    const lineStart = lineStarts[i] ?? 0;
    const lineEnd = i + 1 < lineStarts.length ? (lineStarts[i + 1] ?? text.length) : text.length;

    if (position < lineStart || position >= lineEnd) continue;

    if (isPositionInRanges(position, ts.getLeadingCommentRanges(text, lineStart))) return true;
    if (isPositionInRanges(position, ts.getTrailingCommentRanges(text, lineStart))) return true;
  }

  return false;
}

// =============================================================================
// STRING UTILITIES
// =============================================================================

/**
 * Count unescaped backtick characters in a line.
 */
export function countUnescapedBackticks(line: string): number {
  let count = 0;
  for (let ci = 0; ci < line.length; ci++) {
    if (line[ci] === '`' && (ci === 0 || line[ci - 1] !== '\\')) count++;
  }
  return count;
}

/** Re-export TypeScript namespace for check authors */
// eslint-disable-next-line unicorn/prefer-export-from -- `export * as from 'typescript'` is invalid (typescript uses `export =`); the namespace import + named export form is the only working shape
export { ts };
