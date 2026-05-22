/**
 * Visitor for class methods: `class X { foo() {} }`.
 */

import ts from 'typescript';

import { classifyVisibility } from '../inventory-helpers/classify-visibility.js';
import { extractDecorators } from '../inventory-helpers/extract-decorators.js';
import { extractParams } from '../inventory-helpers/extract-params.js';
import { digestFunctionBody } from '../inventory-helpers/hash-body.js';

import type { InventoryVisitor } from './types.js';

export const visitMethodDeclaration: InventoryVisitor<ts.MethodDeclaration> = (node, ctx) => {
  // Body-less method declarations (overload signatures, abstract methods,
  // method signatures inside ambient declarations) are not callables —
  // they have no implementation to enter the call graph. Per the
  // "real callable iff has body" rule.
  if (!node.body) return null;
  const name = methodName(node);
  if (name === null) return null;
  const start = node.getStart(ctx.sourceFile);
  const startLC = ctx.sourceFile.getLineAndCharacterOfPosition(start);
  const end = ctx.sourceFile.getLineAndCharacterOfPosition(node.getEnd());
  const enclosingClass = ctx.enclosingClass ?? findClassName(node);
  const qualified = enclosingClass
    ? `${ctx.filePathProjectRel.replace(/\.tsx?$/, '')}.${enclosingClass}.${name}`
    : `${ctx.filePathProjectRel.replace(/\.tsx?$/, '')}.${name}`;
  const digest = digestFunctionBody(node, ctx.sourceFile);
  return {
    bodyHash: digest.hash,
    bodySize: digest.size,
    simpleName: name,
    qualifiedName: qualified,
    filePath: ctx.filePathProjectRel,
    line: startLC.line + 1,
    column: startLC.character,
    endLine: end.line + 1,
    kind: 'method',
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

function methodName(node: ts.MethodDeclaration): string | null {
  const n = node.name;
  if (ts.isIdentifier(n)) return n.text;
  if (ts.isStringLiteral(n)) return n.text;
  if (ts.isComputedPropertyName(n)) return n.expression.getText();
  // PrivateIdentifier carries the leading '#' in its text already
  // (e.g. '#priv'), which matches how TypeScript's own AST exposes it.
  if (ts.isPrivateIdentifier(n)) return n.text;
  /* v8 ignore next */
  return null;
}

function findClassName(node: ts.MethodDeclaration): string | null {
  let p: ts.Node | undefined = node.parent;
  while (p) {
    if (ts.isClassDeclaration(p) || ts.isClassExpression(p)) {
      return p.name?.text ?? null;
    }
    p = p.parent;
  }
  return null;
}
