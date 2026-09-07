import ts from 'typescript';

/**
 * Function-shaped nodes that end the search for an enclosing class. Mirrors
 * `walk.ts`'s `descend()`, which resets `ctx.enclosingClass` to `null` when
 * descending into any of these bodies: a method/getter/setter defined inside
 * an object literal that itself sits inside a class method is a local value,
 * not a class member, and must not inherit the outer class's name just
 * because the class happens to be further up the same physical AST chain.
 */
function isFunctionBoundary(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

export function findEnclosingClassName(node: ts.Node): string | null {
  let parent: ts.Node | undefined = node.parent;
  while (parent) {
    if (ts.isClassDeclaration(parent) || ts.isClassExpression(parent)) {
      return parent.name?.text ?? null;
    }
    if (isFunctionBoundary(parent)) return null;
    parent = parent.parent;
  }
  return null;
}
