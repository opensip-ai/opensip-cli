/**
 * AST analysis helpers for the throws-documentation check.
 */

import { type CheckViolation } from '@opensip-cli/fitness';
import * as ts from 'typescript';

import { isSelfDocumentingError } from './throws-documentation-constants.js';

type FunctionLikeNode = ts.FunctionDeclaration | ts.MethodDeclaration | ts.ArrowFunction;

export interface FileAnalysisContext {
  sourceFile: ts.SourceFile;
  content: string;
  filePath: string;
  selfDocumentingSuffixes: readonly string[];
}

function isFunctionLikeNode(n: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(n) ||
    ts.isFunctionExpression(n) ||
    ts.isArrowFunction(n) ||
    ts.isMethodDeclaration(n)
  );
}

function findThrowStatements(node: ts.Node): ts.ThrowStatement[] {
  const throws: ts.ThrowStatement[] = [];

  const visit = (n: ts.Node): void => {
    if (isFunctionLikeNode(n) && n !== node) {
      return;
    }
    if (ts.isThrowStatement(n)) {
      throws.push(n);
    }
    ts.forEachChild(n, visit);
  };

  visit(node);
  return throws;
}

function commentRangesIncludeThrows(
  fullText: string,
  pos: number,
): boolean {
  const comments = ts.getLeadingCommentRanges(fullText, pos);
  if (!comments) return false;
  for (const comment of comments) {
    const commentText = fullText.slice(comment.pos, comment.end);
    if (commentText.includes('@throws')) {
      return true;
    }
  }
  return false;
}

function hasThrowsJSDoc(node: ts.Node, sourceFile: ts.SourceFile): boolean {
  return commentRangesIncludeThrows(sourceFile.getFullText(), node.getFullStart());
}

function hasPropertyAssignmentThrowsJSDoc(
  arrow: ts.ArrowFunction,
  sourceFile: ts.SourceFile,
): boolean {
  const parent = arrow.parent;
  if (!ts.isPropertyAssignment(parent)) return false;
  return commentRangesIncludeThrows(sourceFile.getFullText(), parent.name.getFullStart());
}

function isReturnedClosure(node: ts.ArrowFunction): boolean {
  const parent = node.parent;
  if (ts.isReturnStatement(parent)) return true;
  if (ts.isPropertyAssignment(parent)) {
    let current: ts.Node | undefined = parent.parent;
    while (current) {
      if (ts.isReturnStatement(current)) return true;
      if (isFunctionLikeNode(current)) return false;
      current = current.parent;
    }
  }
  return false;
}

function isFactoryBodyConstArrow(node: ts.ArrowFunction): boolean {
  const parent = node.parent;
  if (!ts.isVariableDeclaration(parent) || parent.initializer !== node) return false;
  const stmt = parent.parent.parent;
  if (!ts.isVariableStatement(stmt)) return false;
  let current: ts.Node | undefined = stmt.parent;
  while (current) {
    if (isFunctionLikeNode(current)) return true;
    if (ts.isSourceFile(current)) return false;
    current = current.parent;
  }
  return false;
}

function hasEnclosingFactoryThrowsJSDoc(
  node: ts.ArrowFunction,
  sourceFile: ts.SourceFile,
): boolean {
  if (!isReturnedClosure(node) && !isFactoryBodyConstArrow(node)) return false;
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isMethodDeclaration(current)
    ) {
      if (hasThrowsJSDoc(current, sourceFile)) return true;
    }
    current = current.parent;
  }
  return false;
}

function getFunctionBody(node: FunctionLikeNode): ts.ConciseBody | undefined {
  if (ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node)) {
    return node.body ?? undefined;
  }
  return node.body;
}

function isInsideTopLevelTry(throwStmt: ts.ThrowStatement, fnNode: FunctionLikeNode): boolean {
  const body = getFunctionBody(fnNode);
  if (!body || !ts.isBlock(body)) return false;
  let current: ts.Node | undefined = throwStmt.parent;
  while (current && current !== fnNode) {
    if (isFunctionLikeNode(current) && current !== fnNode) return false;
    if (ts.isTryStatement(current) && body.statements.includes(current)) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function topLevelTryCatchRethrows(fnNode: FunctionLikeNode): boolean {
  const body = getFunctionBody(fnNode);
  if (!body || !ts.isBlock(body)) return false;
  for (const stmt of body.statements) {
    if (!ts.isTryStatement(stmt)) continue;
    const visit = (n: ts.Node): boolean => {
      if (ts.isThrowStatement(n)) return true;
      if (isFunctionLikeNode(n)) return false;
      let found = false;
      ts.forEachChild(n, (child) => {
        if (visit(child)) found = true;
      });
      return found;
    };
    if (stmt.catchClause && visit(stmt.catchClause)) return true;
  }
  return false;
}

function neverPropagatesThrows(node: FunctionLikeNode): boolean {
  const throwStatements = findThrowStatements(node);
  if (throwStatements.length === 0) return false;
  if (!throwStatements.every((stmt) => isInsideTopLevelTry(stmt, node))) return false;
  return !topLevelTryCatchRethrows(node);
}

const ANONYMOUS_FUNCTION_NAME = '<anonymous>';

function getNameFromFunctionDeclaration(node: ts.FunctionDeclaration): string {
  return node.name?.text ?? ANONYMOUS_FUNCTION_NAME;
}

function getNameFromMethodDeclaration(node: ts.MethodDeclaration): string {
  return ts.isIdentifier(node.name) ? node.name.text : ANONYMOUS_FUNCTION_NAME;
}

function getNameFromArrowFunction(node: ts.ArrowFunction): string {
  const parent = node.parent;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.text;
  }
  return ANONYMOUS_FUNCTION_NAME;
}

// @fitness-ignore-next-line duplicate-utility-functions -- Check-specific helper for FunctionLikeNode
function getFunctionName(node: FunctionLikeNode): string {
  if (ts.isFunctionDeclaration(node)) {
    return getNameFromFunctionDeclaration(node);
  }
  if (ts.isMethodDeclaration(node)) {
    return getNameFromMethodDeclaration(node);
  }
  return getNameFromArrowFunction(node);
}

function isAnonymousCallback(node: ts.ArrowFunction): boolean {
  const parent = node.parent;
  return ts.isCallExpression(parent) || ts.isCallExpression(parent.parent);
}

function extractThrownType(throwStmt: ts.ThrowStatement, sourceFile: ts.SourceFile): string {
  const text = throwStmt.expression.getText(sourceFile);
  // @fitness-ignore-next-line sonarjs-backend -- Safe regex with fixed tokens for extracting error class name
  const typeMatch = /new\s+(\w+)/.exec(text);
  return typeMatch?.[1] ?? 'Error';
}

function getUniqueThrowTypes(
  throwStatements: ts.ThrowStatement[],
  sourceFile: ts.SourceFile,
): string[] {
  if (!Array.isArray(throwStatements)) {
    return [];
  }
  const thrownTypes = throwStatements.map((t) => extractThrownType(t, sourceFile));
  return [...new Set(thrownTypes)];
}

function createMissingThrowsViolation(
  node: FunctionLikeNode,
  funcName: string,
  throwStatements: ts.ThrowStatement[],
  ctx: FileAnalysisContext,
): CheckViolation {
  if (!Array.isArray(throwStatements)) {
    throw new TypeError('throwStatements must be an array');
  }
  const { line, character } = ctx.sourceFile.getLineAndCharacterOfPosition(node.getStart());
  const lineNum = line + 1;
  const uniqueTypes = getUniqueThrowTypes(throwStatements, ctx.sourceFile);

  return {
    line: lineNum,
    column: character + 1,
    message: `Function '${funcName}' throws but lacks @throws JSDoc`,
    severity: 'warning',
    suggestion: `Add @throws JSDoc above the function: /** @throws {${uniqueTypes.join(' | ')}} Description of when this error is thrown */`,
    match: funcName,
  };
}

function shouldAnalyzeFunction(node: FunctionLikeNode, funcName: string): boolean {
  if (funcName === '<anonymous>' && ts.isArrowFunction(node)) {
    return !isAnonymousCallback(node);
  }
  return true;
}

function allThrowsSelfDocumenting(
  throwStatements: ts.ThrowStatement[],
  sourceFile: ts.SourceFile,
  suffixes: readonly string[],
): boolean {
  if (!Array.isArray(throwStatements) || throwStatements.length === 0) {
    return false;
  }
  return throwStatements.every((stmt) => {
    const errorType = extractThrownType(stmt, sourceFile);
    return isSelfDocumentingError(errorType, suffixes);
  });
}

const ERROR_FIELD_NAME_PATTERN = /^(error|err|cause|innerError|originalError)$/i;
const ERROR_VAR_NAME_PATTERN = /^(error|err|e|ex|exception)$/i;

function collectCaughtErrorNames(fnNode: ts.Node): Set<string> {
  const names = new Set<string>();
  const visit = (n: ts.Node): void => {
    if (isFunctionLikeNode(n) && n !== fnNode) {
      return;
    }
    if (ts.isCatchClause(n) && n.variableDeclaration) {
      const decl = n.variableDeclaration;
      if (ts.isIdentifier(decl.name)) {
        names.add(decl.name.text);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(fnNode);
  return names;
}

// eslint-disable-next-line sonarjs/cognitive-complexity -- rethrow heuristic AST shapes
function isRethrow(
  throwStmt: ts.ThrowStatement,
  sourceFile: ts.SourceFile,
  caughtNames?: Set<string>,
): boolean {
  const expr = throwStmt.expression;
  const text = expr.getText(sourceFile).trim();

  if (ts.isNewExpression(expr)) return false;

  if (ts.isIdentifier(expr)) {
    if (caughtNames?.has(expr.text)) return true;
    return ERROR_VAR_NAME_PATTERN.test(expr.text);
  }

  if (
    ts.isPropertyAccessExpression(expr) &&
    expr.expression.kind === ts.SyntaxKind.ThisKeyword &&
    ts.isIdentifier(expr.name) &&
    ERROR_FIELD_NAME_PATTERN.test(expr.name.text)
  ) {
    return true;
  }

  if (ts.isCallExpression(expr) && ts.isPropertyAccessExpression(expr.expression)) {
    const methodName = ts.isIdentifier(expr.expression.name) ? expr.expression.name.text : '';
    if (methodName === 'unwrapErr' || methodName === 'unwrap') {
      return true;
    }
    const root = expr.expression.expression;
    if (ts.isIdentifier(root) && caughtNames?.has(root.text)) {
      return true;
    }
  }

  if (ts.isCallExpression(expr) && expr.arguments.length === 1) {
    const arg = expr.arguments[0];
    if (arg && ts.isIdentifier(arg)) {
      if (caughtNames?.has(arg.text)) return true;
      if (!caughtNames && ERROR_VAR_NAME_PATTERN.test(arg.text)) return true;
    }
  }

  return !text.includes('new ') && ERROR_VAR_NAME_PATTERN.test(text);
}

function matchesInstanceofGuard(
  cond: ts.Expression,
  thrown: ts.Expression,
  sourceFile: ts.SourceFile,
): boolean {
  if (!ts.isIdentifier(thrown)) return false;
  if (!ts.isBinaryExpression(cond) || cond.operatorToken.kind !== ts.SyntaxKind.InstanceOfKeyword) {
    return false;
  }
  return cond.left.getText(sourceFile) === thrown.text;
}

function isInstanceofGuardedRethrow(
  throwStmt: ts.ThrowStatement,
  sourceFile: ts.SourceFile,
): boolean {
  const parent = throwStmt.parent;
  const thrown = throwStmt.expression;

  if (ts.isIfStatement(parent)) {
    return matchesInstanceofGuard(parent.expression, thrown, sourceFile);
  }

  if (!ts.isBlock(parent)) return false;
  const siblings = parent.statements;
  const idx = siblings.indexOf(throwStmt);
  if (idx <= 0) return false;
  const prev = siblings[idx - 1];
  if (!ts.isIfStatement(prev)) return false;
  return matchesInstanceofGuard(prev.expression, thrown, sourceFile);
}

function analyzeFunctionNode(
  node: FunctionLikeNode,
  ctx: FileAnalysisContext,
): CheckViolation | null {
  const funcName = getFunctionName(node);

  if (!shouldAnalyzeFunction(node, funcName)) {
    return null;
  }

  const throwStatements = findThrowStatements(node);

  if (throwStatements.length === 0) {
    return null;
  }

  if (hasThrowsJSDoc(node, ctx.sourceFile)) {
    return null;
  }

  if (ts.isArrowFunction(node)) {
    if (hasPropertyAssignmentThrowsJSDoc(node, ctx.sourceFile)) {
      return null;
    }
    if (hasEnclosingFactoryThrowsJSDoc(node, ctx.sourceFile)) {
      return null;
    }
  }

  if (neverPropagatesThrows(node)) {
    return null;
  }

  if (allThrowsSelfDocumenting(throwStatements, ctx.sourceFile, ctx.selfDocumentingSuffixes)) {
    return null;
  }

  const caughtNames = collectCaughtErrorNames(node);
  if (
    throwStatements.every(
      (stmt) =>
        isRethrow(stmt, ctx.sourceFile, caughtNames) ||
        isInstanceofGuardedRethrow(stmt, ctx.sourceFile),
    )
  ) {
    return null;
  }

  return createMissingThrowsViolation(node, funcName, throwStatements, ctx);
}

/** Analyze a file for missing @throws documentation. */
export function analyzeFile(ctx: FileAnalysisContext): CheckViolation[] {
  const violations: CheckViolation[] = [];

  const visit = (node: ts.Node): void => {
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isArrowFunction(node)
    ) {
      const violation = analyzeFunctionNode(node, ctx);
      if (violation) {
        violations.push(violation);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(ctx.sourceFile);
  return violations;
}
