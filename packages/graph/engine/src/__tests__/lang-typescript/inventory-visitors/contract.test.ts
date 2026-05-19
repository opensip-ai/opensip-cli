/**
 * InventoryVisitor contract conformance (PR-5).
 *
 * Compile-time test seam: six of the seven visitors implement the
 * InventoryVisitor signature alias. module-init.ts is the deliberate
 * exception (one-per-file synthesis, not per-node visit).
 */

import { describe, expect, it } from 'vitest';


import { visitArrowFunction } from '../../../lang-typescript/inventory-visitors/arrow-function.js';
import { visitConstructorDeclaration } from '../../../lang-typescript/inventory-visitors/constructor-declaration.js';
import { visitFunctionDeclaration } from '../../../lang-typescript/inventory-visitors/function-declaration.js';
import { visitFunctionExpression } from '../../../lang-typescript/inventory-visitors/function-expression.js';
import { visitGetterSetter } from '../../../lang-typescript/inventory-visitors/getter-setter.js';
import { visitMethodDeclaration } from '../../../lang-typescript/inventory-visitors/method-declaration.js';

import type { InventoryVisitor } from '../../../lang-typescript/inventory-visitors/types.js';
import type ts from 'typescript';

const _decl: InventoryVisitor<ts.FunctionDeclaration> = visitFunctionDeclaration;
const _arrow: InventoryVisitor<ts.ArrowFunction> = visitArrowFunction;
const _method: InventoryVisitor<ts.MethodDeclaration> = visitMethodDeclaration;
const _ctor: InventoryVisitor<ts.ConstructorDeclaration> = visitConstructorDeclaration;
const _accessor: InventoryVisitor<ts.AccessorDeclaration> = visitGetterSetter;
const _expr: InventoryVisitor<ts.FunctionExpression> = visitFunctionExpression;

// module-init.ts is excluded with a comment explaining the deliberate
// exception (PR-5).

describe('InventoryVisitor contract conformance (PR-5)', () => {
  it('all six conforming visitors implement the InventoryVisitor alias at compile time', () => {
    expect(typeof _decl).toBe('function');
    expect(typeof _arrow).toBe('function');
    expect(typeof _method).toBe('function');
    expect(typeof _ctor).toBe('function');
    expect(typeof _accessor).toBe('function');
    expect(typeof _expr).toBe('function');
  });
});
