/**
 * Visitor for arrow functions: `() => ...` (named via parent variable
 * declaration when possible; otherwise synthesized).
 */

import { classifyVisibility } from '../inventory-helpers/classify-visibility.js';
import { extractParams } from '../inventory-helpers/extract-params.js';
import { digestFunctionBody } from '../inventory-helpers/hash-body.js';
import { inferNameFromParent } from '../inventory-helpers/infer-parent-name.js';
import { synthesizeArrowName } from '../inventory-helpers/synthesize-name.js';

import type { InventoryVisitor } from './types.js';
import type ts from 'typescript';

export const visitArrowFunction: InventoryVisitor<ts.ArrowFunction> = (node, ctx) => {
  const start = node.getStart(ctx.sourceFile);
  const startLC = ctx.sourceFile.getLineAndCharacterOfPosition(start);
  const end = ctx.sourceFile.getLineAndCharacterOfPosition(node.getEnd());

  const name =
    inferNameFromParent(node) ??
    synthesizeArrowName({
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
    kind: 'arrow',
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
