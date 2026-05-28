// @fitness-ignore-file batch-operation-limits -- iterates bounded collection (decorators on a single class member; small N by language spec)
/**
 * Extract decorator names from a TS class-member or class node.
 */

import ts from 'typescript';

/* v8 ignore start */
export function extractDecorators(node: ts.Node): readonly string[] {
  const out: string[] = [];
  // ts.canHaveDecorators is the modern accessor; fall back to legacy decorators on older AST shapes.
  const decorators = ts.canHaveDecorators(node) ? ts.getDecorators(node) : undefined;
  if (decorators) {
    for (const d of decorators) {
      out.push(decoratorName(d));
    }
  }
  return out;
}

function decoratorName(d: ts.Decorator): string {
  const expr = d.expression;
  if (ts.isCallExpression(expr)) {
    return expressionName(expr.expression);
  }
  return expressionName(expr);
}

function expressionName(expr: ts.Expression): string {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return expr.getText();
}
/* v8 ignore stop */
