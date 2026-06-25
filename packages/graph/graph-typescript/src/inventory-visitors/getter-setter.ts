/**
 * Visitor for class getters/setters: `get x()` / `set x()`.
 */

import ts from 'typescript';

import { classifyVisibility } from '../inventory-helpers/classify-visibility.js';
import { findEnclosingClassName } from '../inventory-helpers/enclosing-class.js';
import { extractDecorators } from '../inventory-helpers/extract-decorators.js';
import { extractParams } from '../inventory-helpers/extract-params.js';
import { digestFunctionBody } from '../inventory-helpers/hash-body.js';

import type { InventoryVisitor } from './types.js';

export const visitGetterSetter: InventoryVisitor<ts.AccessorDeclaration> = (node, ctx) => {
  const name = accessorName(node);
  if (name === null) return null;
  const start = node.getStart(ctx.sourceFile);
  const startLC = ctx.sourceFile.getLineAndCharacterOfPosition(start);
  const end = ctx.sourceFile.getLineAndCharacterOfPosition(node.getEnd());
  const enclosingClass = ctx.enclosingClass ?? findEnclosingClassName(node);
  const kind = node.kind === ts.SyntaxKind.GetAccessor ? 'getter' : 'setter';
  const qualified = enclosingClass
    ? `${ctx.filePathProjectRel.replace(/\.tsx?$/, '')}.${enclosingClass}.${name}`
    : `${ctx.filePathProjectRel.replace(/\.tsx?$/, '')}.${name}`;
  const digest = digestFunctionBody(node, ctx.sourceFile);
  return {
    bodyHash: digest.hash,
    bodySize: digest.size,
    bodySignature: digest.signature,
    simpleName: name,
    qualifiedName: qualified,
    filePath: ctx.filePathProjectRel,
    line: startLC.line + 1,
    column: startLC.character,
    endLine: end.line + 1,
    kind,
    params: extractParams(node),
    returnType: node.type ? node.type.getText(ctx.sourceFile) : null,
    enclosingClass,
    decorators: extractDecorators(node),
    visibility: classifyVisibility(node),
    inTestFile: ctx.inTestFile,
    definedInGenerated: ctx.definedInGenerated,
    calls: [],
  };
};

function accessorName(node: ts.AccessorDeclaration): string | null {
  const n = node.name;
  if (ts.isIdentifier(n)) return n.text;
  /* v8 ignore next 2 */
  if (ts.isStringLiteral(n)) return n.text;
  return null;
}
