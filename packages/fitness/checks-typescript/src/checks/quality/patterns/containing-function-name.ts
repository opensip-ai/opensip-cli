import * as ts from 'typescript';

export function getContainingFunctionName(
  node: ts.Node,
  sourceFile: ts.SourceFile,
): string | undefined {
  let current: ts.Node | undefined = node.parent;

  while (current) {
    if (ts.isFunctionDeclaration(current) && current.name) {
      return current.name.getText(sourceFile);
    }

    if (ts.isMethodDeclaration(current) && current.name) {
      return current.name.getText(sourceFile);
    }

    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
      const parent = current.parent;
      if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
        return parent.name.getText(sourceFile);
      }
    }
    current = current.parent;
  }
  return undefined;
}
