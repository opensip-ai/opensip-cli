import ts from 'typescript';

export function inferNameFromParent(node: ts.ArrowFunction | ts.FunctionExpression): string | null {
  const parent = node.parent;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  if (
    ts.isPropertyDeclaration(parent) &&
    (ts.isIdentifier(parent.name) || ts.isPrivateIdentifier(parent.name))
  ) {
    return parent.name.text;
  }
  if (ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  return null;
}
