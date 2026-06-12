// @fitness-ignore-file batch-operation-limits -- iterates bounded collection (parameters on a single function declaration)
/**
 * Extract Param[] from a TS function-shaped node.
 */

import ts from 'typescript';

import type { Param } from '@opensip-cli/graph';

export function extractParams(
  node: ts.SignatureDeclaration | ts.FunctionLikeDeclaration,
): readonly Param[] {
  const params: Param[] = [];
  for (const p of node.parameters) {
    params.push({
      name: extractName(p.name),
      optional: p.questionToken !== undefined || p.initializer !== undefined,
      rest: p.dotDotDotToken !== undefined,
    });
  }
  return params;
}

/* v8 ignore start */
function extractName(name: ts.BindingName): string {
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isObjectBindingPattern(name)) return '{...}';
  if (ts.isArrayBindingPattern(name)) return '[...]';
  return '<param>';
}
/* v8 ignore stop */
