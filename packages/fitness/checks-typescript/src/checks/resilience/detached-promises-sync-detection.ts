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

/**
 * True when `name` refers to a top-level sync function or const arrow in `sourceFile`.
 */
export function isSyncTopLevelCallable(sourceFile: ts.SourceFile, name: string): boolean {
  for (const stmt of sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === name) {
      if (isNonAsyncFunctionLike(stmt)) return true;
      continue;
    }

    if (!ts.isVariableStatement(stmt)) continue;

    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || decl.name.text !== name) continue;
      if (initializerIsSyncCallable(decl.initializer)) return true;
    }
  }

  return false;
}