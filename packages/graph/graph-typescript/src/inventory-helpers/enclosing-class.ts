import ts from 'typescript';

export function findEnclosingClassName(node: ts.Node): string | null {
  let parent: ts.Node | undefined = node.parent;
  while (parent) {
    if (ts.isClassDeclaration(parent) || ts.isClassExpression(parent)) {
      return parent.name?.text ?? null;
    }
    parent = parent.parent;
  }
  return null;
}
