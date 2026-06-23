/**
 * Same-file sync callable detection for detached-promises.
 */

import * as ts from 'typescript';

function isNonAsyncFunctionLike(
  node: ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction,
): boolean {
  return !node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
}

function initializerIsSyncCallable(init: ts.Expression | undefined): boolean {
  if (!init) return false;
  if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
    return isNonAsyncFunctionLike(init);
  }
  return false;
}

function isSyncNamedFunctionDeclaration(stmt: ts.Statement, name: string): boolean {
  if (!ts.isFunctionDeclaration(stmt) || stmt.name?.text !== name) return false;
  return isNonAsyncFunctionLike(stmt);
}

function isSyncNamedConstArrow(stmt: ts.Statement, name: string): boolean {
  if (!ts.isVariableStatement(stmt)) return false;
  for (const decl of stmt.declarationList.declarations) {
    if (!ts.isIdentifier(decl.name) || decl.name.text !== name) continue;
    if (initializerIsSyncCallable(decl.initializer)) return true;
  }
  return false;
}

/**
 * True when `name` refers to a top-level sync function or const arrow in `sourceFile`.
 */
export function isSyncTopLevelCallable(sourceFile: ts.SourceFile, name: string): boolean {
  return sourceFile.statements.some(
    (stmt) => isSyncNamedFunctionDeclaration(stmt, name) || isSyncNamedConstArrow(stmt, name),
  );
}
