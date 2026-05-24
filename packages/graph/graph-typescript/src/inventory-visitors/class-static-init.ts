/**
 * Visitor for class static initialization blocks: `class C { static {} }`.
 *
 * Static blocks carry executable code that runs at class-evaluation
 * time. They are real callables in the call graph: any references they
 * make (constructors, methods, helpers) belong to the static block, not
 * to the surrounding class. Per the "module-init" pattern, we
 * synthesize one occurrence per block, named '<static-init>', parented
 * to the enclosing class.
 *
 * Multiple static blocks on a single class are allowed by the language
 * and produce one occurrence per block (line/column disambiguates).
 */

import { digestFunctionBody } from '../inventory-helpers/hash-body.js';

import type { InventoryVisitor } from './types.js';
import type ts from 'typescript';

export const visitClassStaticBlock: InventoryVisitor<ts.ClassStaticBlockDeclaration> = (
  node,
  ctx,
) => {
  const start = node.getStart(ctx.sourceFile);
  const startLC = ctx.sourceFile.getLineAndCharacterOfPosition(start);
  const end = ctx.sourceFile.getLineAndCharacterOfPosition(node.getEnd());
  const enclosingClass = ctx.enclosingClass;
  const qualified = enclosingClass
    ? `${ctx.filePathProjectRel.replace(/\.tsx?$/, '')}.${enclosingClass}.<static-init>`
    /* v8 ignore next */
    : `${ctx.filePathProjectRel.replace(/\.tsx?$/, '')}.<static-init>`;
  const digest = digestFunctionBody(node, ctx.sourceFile);
  return {
    bodyHash: digest.hash,
    bodySize: digest.size,
    simpleName: '<static-init>',
    qualifiedName: qualified,
    filePath: ctx.filePathProjectRel,
    line: startLC.line + 1,
    column: startLC.character,
    endLine: end.line + 1,
    kind: 'function-declaration',
    params: [],
    returnType: null,
    enclosingClass,
    decorators: [],
    visibility: 'private',
    inTestFile: ctx.inTestFile,
    definedInGenerated: ctx.definedInGenerated,
    calls: [],
  };
};
