/**
 * Visitor for function expressions: `const x = function() {}`, IIFEs.
 */

import ts from 'typescript';

import { classifyVisibility } from '../inventory-helpers/classify-visibility.js';
import { extractParams } from '../inventory-helpers/extract-params.js';
import { digestFunctionBody } from '../inventory-helpers/hash-body.js';
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

function inferNameFromParent(node: ts.FunctionExpression): string | null {
  const p = node.parent;
  if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
  if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) return p.name.text;
  // class X { foo = function() {} } — both public and #private fields.
  if (ts.isPropertyDeclaration(p) && (ts.isIdentifier(p.name) || ts.isPrivateIdentifier(p.name))) {
    return p.name.text;
  }
  return null;
}
