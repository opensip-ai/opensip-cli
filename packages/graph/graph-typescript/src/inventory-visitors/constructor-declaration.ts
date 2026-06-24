/**
 * Visitor for class constructors: `class X { constructor() {} }`.
 */

import ts from 'typescript';

import { classifyVisibility } from '../inventory-helpers/classify-visibility.js';
import { extractParams } from '../inventory-helpers/extract-params.js';
import { digestFunctionBody } from '../inventory-helpers/hash-body.js';

import type { InventoryVisitor } from './types.js';

export const visitConstructorDeclaration: InventoryVisitor<ts.ConstructorDeclaration> = (
  node,
  ctx,
) => {
  const start = node.getStart(ctx.sourceFile);
  const startLC = ctx.sourceFile.getLineAndCharacterOfPosition(start);
  const end = ctx.sourceFile.getLineAndCharacterOfPosition(node.getEnd());
  /* v8 ignore next */
  const className = ctx.enclosingClass ?? findClassName(node) ?? '<anon-class>';
  const digest = digestFunctionBody(node, ctx.sourceFile);
  return {
    bodyHash: digest.hash,
    bodySize: digest.size,
    bodySignature: digest.signature,
    simpleName: className,
    qualifiedName: `${ctx.filePathProjectRel.replace(/\.tsx?$/, '')}.${className}.constructor`,
    filePath: ctx.filePathProjectRel,
    line: startLC.line + 1,
    column: startLC.character,
    endLine: end.line + 1,
    kind: 'constructor',
    params: extractParams(node),
    returnType: null,
    enclosingClass: className,
    decorators: [],
    visibility: classifyVisibility(node),
    inTestFile: ctx.inTestFile,
    definedInGenerated: ctx.definedInGenerated,
    calls: [],
  };
};

/* v8 ignore start */
function findClassName(node: ts.ConstructorDeclaration): string | null {
  let p: ts.Node | undefined = node.parent;
  while (p) {
    if (ts.isClassDeclaration(p) || ts.isClassExpression(p)) {
      return p.name?.text ?? null;
    }
    p = p.parent;
  }
  return null;
}
/* v8 ignore stop */
