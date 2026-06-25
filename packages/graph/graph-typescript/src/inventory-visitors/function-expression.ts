/**
 * Visitor for function expressions: `const x = function() {}`, IIFEs.
 */

import ts from 'typescript';

import { classifyVisibility } from '../inventory-helpers/classify-visibility.js';
import { extractParams } from '../inventory-helpers/extract-params.js';
import { digestFunctionBody } from '../inventory-helpers/hash-body.js';
import { inferNameFromParent } from '../inventory-helpers/infer-parent-name.js';
import { synthesizeFunctionExpressionName } from '../inventory-helpers/synthesize-name.js';

import type { InventoryVisitor } from './types.js';

export const visitFunctionExpression: InventoryVisitor<ts.FunctionExpression> = (node, ctx) => {
  const start = node.getStart(ctx.sourceFile);
  const startLC = ctx.sourceFile.getLineAndCharacterOfPosition(start);
  const end = ctx.sourceFile.getLineAndCharacterOfPosition(node.getEnd());

  const name =
    node.name?.text ??
    inferNameFromParent(node) ??
    synthesizeFunctionExpressionName({
      filePath: ctx.filePathProjectRel,
      line: startLC.line + 1,
      column: startLC.character,
    });

  const digest = digestFunctionBody(node, ctx.sourceFile);
  return {
    bodyHash: digest.hash,
    bodySize: digest.size,
    bodySignature: digest.signature,
    simpleName: name,
    qualifiedName: `${ctx.filePathProjectRel.replace(/\.tsx?$/, '')}.${name}`,
    filePath: ctx.filePathProjectRel,
    line: startLC.line + 1,
    column: startLC.character,
    endLine: end.line + 1,
    kind: 'function-expression',
    params: extractParams(node),
    returnType: node.type ? node.type.getText(ctx.sourceFile) : null,
    enclosingClass: ctx.enclosingClass,
    decorators: [],
    visibility: classifyVisibility(node),
    inTestFile: ctx.inTestFile,
    definedInGenerated: ctx.definedInGenerated,
    calls: [],
  };
};
