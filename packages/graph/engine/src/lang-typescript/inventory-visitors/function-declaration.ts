/**
 * Visitor for `function foo() {}` declarations.
 */


import ts from 'typescript';

import { classifyVisibility } from '../inventory-helpers/classify-visibility.js';
import { extractDecorators } from '../inventory-helpers/extract-decorators.js';
import { extractParams } from '../inventory-helpers/extract-params.js';
import { digestFunctionBody } from '../inventory-helpers/hash-body.js';

import type { InventoryVisitor } from './types.js';

export const visitFunctionDeclaration: InventoryVisitor<ts.FunctionDeclaration> = (node, ctx) => {
  // Body-less function declarations (overload signatures, ambient
  // `declare function` forms) are not callables — they have no
  // implementation to enter the call graph.
  /* v8 ignore next */
  if (!node.body) return null;
  const name = resolveFunctionName(node);
  /* v8 ignore next */
  if (name === null) return null;
  const start = node.getStart(ctx.sourceFile);
  const startLC = ctx.sourceFile.getLineAndCharacterOfPosition(start);
  const end = ctx.sourceFile.getLineAndCharacterOfPosition(node.getEnd());
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

/**
 * `export default function() {}` is the special case where a
 * FunctionDeclaration is allowed to be anonymous. We synthesize a
 * stable simpleName so the catalog records the callable. Anywhere else,
 * an unnamed FunctionDeclaration is a parser-level error and we drop
 * it safely.
 */
function resolveFunctionName(node: ts.FunctionDeclaration): string | null {
  if (node.name) return node.name.text;
  const isDefaultExport = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword) === true;
  if (isDefaultExport) return '<default>';
  return null;
}
