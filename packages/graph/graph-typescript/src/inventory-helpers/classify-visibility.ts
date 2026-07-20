/**
 * Classify a function/method's visibility — exported, module-local, private.
 */

import ts from 'typescript';

import type { Visibility } from '@opensip-cli/graph';

/**
 * For a top-level function/variable: 'exported' if it has the export
 * modifier (or is part of an export specifier); 'module-local'
 * otherwise. Class members default to module-local unless explicitly
 * private.
 */
export function classifyVisibility(node: ts.Node): Visibility {
  const direct = directVisibility(node);
  if (direct !== null) return direct;
  if (parentIsPrivateClassMember(node)) return 'private';
  if (isDirectExportAssignment(node)) return 'exported';
  if (parentIsExportedVariableStatement(node)) return 'exported';
  if (isExportedThroughList(node)) return 'exported';
  return 'module-local';
}

function directVisibility(node: ts.Node): Visibility | null {
  if (hasPrivateName(node)) return 'private';
  /* v8 ignore next */
  if (!ts.canHaveModifiers(node)) return null;
  const modifiers = ts.getModifiers(node);
  if (!modifiers) return null;
  for (const m of modifiers) {
    if (m.kind === ts.SyntaxKind.PrivateKeyword) return 'private';
    if (m.kind === ts.SyntaxKind.ExportKeyword) return 'exported';
  }
  return null;
}

function hasPrivateName(node: ts.Node): boolean {
  const name = (node as ts.NamedDeclaration).name;
  return name !== undefined && ts.isPrivateIdentifier(name);
}

function parentIsPrivateClassMember(node: ts.Node): boolean {
  let parent: ts.Node | undefined = node.parent;
  while (parent !== undefined) {
    if (ts.isPropertyDeclaration(parent)) {
      return directVisibility(parent) === 'private';
    }
    if (ts.isFunctionLike(parent) || ts.isClassLike(parent)) return false;
    parent = parent.parent;
  }
  return false;
}

function isDirectExportAssignment(node: ts.Node): boolean {
  let expression: ts.Node = node;
  let parent = expression.parent;
  while (parent !== undefined) {
    if (ts.isExportAssignment(parent)) return parent.expression === expression;
    if (
      (ts.isParenthesizedExpression(parent) ||
        ts.isAsExpression(parent) ||
        ts.isSatisfiesExpression(parent) ||
        ts.isTypeAssertionExpression(parent) ||
        ts.isNonNullExpression(parent)) &&
      parent.expression === expression
    ) {
      expression = parent;
      parent = parent.parent;
      continue;
    }
    return false;
  }
  return false;
}

function parentIsExportedVariableStatement(node: ts.Node): boolean {
  // Walk up to a VariableStatement and look for `export` modifier (handles
  // `export const foo = () => {}`).
  let parent: ts.Node | undefined = node.parent;
  while (parent) {
    if (ts.isVariableStatement(parent)) {
      return hasExportModifier(parent);
    }
    if (ts.isClassLike(parent) || ts.isFunctionLike(parent)) return false;
    parent = parent.parent;
  }
  return false;
}

function hasExportModifier(node: ts.VariableStatement): boolean {
  const mods = ts.getModifiers(node);
  if (!mods) return false;
  return mods.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

function isExportedThroughList(node: ts.Node): boolean {
  const bindingName = topLevelBindingName(node);
  if (bindingName === null) return false;
  const sourceFile = node.getSourceFile();
  for (const statement of sourceFile.statements) {
    if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier === undefined &&
      statement.exportClause !== undefined &&
      ts.isNamedExports(statement.exportClause) &&
      statement.exportClause.elements.some(
        (element) => (element.propertyName ?? element.name).text === bindingName,
      )
    ) {
      return true;
    }
    if (
      ts.isExportAssignment(statement) &&
      ts.isIdentifier(statement.expression) &&
      statement.expression.text === bindingName
    ) {
      return true;
    }
  }
  return false;
}

function topLevelBindingName(node: ts.Node): string | null {
  if (ts.isFunctionDeclaration(node) && ts.isSourceFile(node.parent) && node.name !== undefined) {
    return node.name.text;
  }

  let bindingName: string | null = null;
  let parent: ts.Node | undefined = node.parent;
  while (parent !== undefined) {
    if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
      bindingName = parent.name.text;
    }
    if (ts.isVariableStatement(parent)) {
      return ts.isSourceFile(parent.parent) ? bindingName : null;
    }
    if (ts.isFunctionLike(parent) || ts.isClassLike(parent)) return null;
    parent = parent.parent;
  }
  return null;
}
