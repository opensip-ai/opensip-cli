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

function blockDeclaresSyncCallable(block: ts.Block, name: string): boolean {
  return block.statements.some(
    (stmt) => isSyncNamedFunctionDeclaration(stmt, name) || isSyncNamedConstArrow(stmt, name),
  );
}

function isDirectFunctionBodyBlock(block: ts.Block): boolean {
  const parent = block.parent;
  return (
    parent !== undefined &&
    (ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isArrowFunction(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isConstructorDeclaration(parent))
  );
}

/**
 * True when `name` refers to a top-level sync function or const arrow in `sourceFile`.
 */
export function isSyncTopLevelCallable(sourceFile: ts.SourceFile, name: string): boolean {
  return sourceFile.statements.some(
    (stmt) => isSyncNamedFunctionDeclaration(stmt, name) || isSyncNamedConstArrow(stmt, name),
  );
}

/**
 * True when `name` refers to a sync helper declared in an enclosing scope of `callSite`
 * (nested `function` declarations or local `const` arrows), or at module top level.
 */
export function isSyncCallableInScope(
  callSite: ts.Node,
  sourceFile: ts.SourceFile,
  name: string,
): boolean {
  if (isSyncTopLevelCallable(sourceFile, name)) return true;

  let current: ts.Node | undefined = callSite;
  while (current) {
    if (ts.isSourceFile(current)) break;
    if (
      ts.isBlock(current) &&
      isDirectFunctionBodyBlock(current) &&
      blockDeclaresSyncCallable(current, name)
    )
      return true;
    current = current.parent;
  }
  return false;
}
