/**
 * Classify a function/method's visibility — exported, module-local, private.
 */

import ts from 'typescript';

import type { Visibility } from '@opensip-tools/graph';

/**
 * For a top-level function/variable: 'exported' if it has the export
 * modifier (or is part of an export specifier); 'module-local'
 * otherwise. Class members default to module-local unless explicitly
 * private.
 */
export function classifyVisibility(node: ts.Node): Visibility {
  const direct = directVisibility(node);
  if (direct !== null) return direct;
  if (parentIsExportedVariableStatement(node)) return 'exported';
  return 'module-local';
}

function directVisibility(node: ts.Node): Visibility | null {
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

function parentIsExportedVariableStatement(node: ts.Node): boolean {
  // Walk up to a VariableStatement and look for `export` modifier (handles
  // `export const foo = () => {}`).
  let parent: ts.Node | undefined = node.parent;
  while (parent) {
    if (ts.isVariableStatement(parent)) {
      return hasExportModifier(parent);
    }
    if (ts.isClassDeclaration(parent) || ts.isFunctionDeclaration(parent)) return false;
    parent = parent.parent;
  }
  return false;
}

function hasExportModifier(node: ts.VariableStatement): boolean {
  const mods = ts.getModifiers(node);
  if (!mods) return false;
  return mods.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}
