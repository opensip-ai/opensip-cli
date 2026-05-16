/**
 * Visitor for `function foo() {}` declarations.
 */


import { classifyVisibility } from '../inventory-helpers/classify-visibility.js';
import { extractDecorators } from '../inventory-helpers/extract-decorators.js';
import { extractParams } from '../inventory-helpers/extract-params.js';
import { hashFunctionBody } from '../inventory-helpers/hash-body.js';

import type { InventoryVisitor } from './types.js';
import type ts from 'typescript';

export const visitFunctionDeclaration: InventoryVisitor<ts.FunctionDeclaration> = (node, ctx) => {
  if (!node.name) return null;
  const name = node.name.text;
  const start = node.getStart(ctx.sourceFile);
  const startLC = ctx.sourceFile.getLineAndCharacterOfPosition(start);
  const end = ctx.sourceFile.getLineAndCharacterOfPosition(node.getEnd());
  return {
    bodyHash: hashFunctionBody(node, ctx.sourceFile),
    simpleName: name,
    qualifiedName: `${ctx.filePathProjectRel.replace(/\.tsx?$/, '')}.${name}`,
    filePath: ctx.filePathProjectRel,
    line: startLC.line + 1,
    column: startLC.character,
    endLine: end.line + 1,
    kind: 'function-declaration',
    params: extractParams(node),
    returnType: node.type ? node.type.getText(ctx.sourceFile) : null,
    enclosingClass: ctx.enclosingClass,
    decorators: extractDecorators(node),
    visibility: classifyVisibility(node),
    inTestFile: ctx.inTestFile,
    definedInGenerated: ctx.definedInGenerated,
    calls: [],
  };
};
