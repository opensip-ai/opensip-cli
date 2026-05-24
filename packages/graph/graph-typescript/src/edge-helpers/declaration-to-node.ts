/**
 * Map a TypeScript Declaration to the function-shaped node that owns
 * its catalog entry.
 *
 * Four resolver files used to inline their own near-identical copy
 * of this logic — each accepting a slightly different set of
 * declaration shapes. The duplicated-function-body rule flagged the
 * group; consolidating onto one helper with a `DeclShape` bitmask
 * makes the per-resolver intent explicit.
 *
 * Declaration shapes are bit flags so callers can OR exactly the
 * subset their resolver accepts. The mask is matched against the
 * declaration type before unwrapping (Variable / Property
 * declarations dereference their initializer to find the actual
 * function-shape).
 */

import ts from 'typescript';

/**
 * Bit-flag set of declaration shapes acceptable in a given resolver
 * context. OR the shapes a resolver should accept and pass the result
 * to {@link functionLikeFromDeclaration}.
 */
export const DeclShape = {
  /** `function foo() {}` */
  FunctionDeclaration: 1,
  /** `() => ...` */
  ArrowFunction: 2,
  /** `function () {}` (the expression form). */
  FunctionExpression: 4,
  /** Class method: `foo() {}` inside a class body. */
  MethodDeclaration: 8,
  /** `constructor() {}`. */
  ConstructorDeclaration: 16,
  /** `get foo() {}` / `set foo(v) {}`. */
  Accessor: 32,
  /** Interface method declarations: `foo(): void;`. */
  MethodSignature: 64,
  /** Class property declarations (used by polymorphic dispatch). */
  PropertyDeclaration: 128,
  /** `const foo = () => ...` / `const foo = function () {}` — unwrap initializer. */
  VariableInitializer: 256,
  /** `{ foo: () => ... }` / `{ foo: function () {} }` — unwrap initializer. */
  PropertyAssignmentInitializer: 512,
} as const;

/**
 * Direct (un-unwrapped) shape predicate table. Each entry pairs a
 * declaration-shape bit with the matching `ts.is*` guard. The lookup
 * loop in {@link functionLikeFromDeclaration} keeps the cyclomatic
 * complexity low compared to the if-ladder it replaced.
 */
const DIRECT_SHAPE_TABLE: readonly (readonly [number, (d: ts.Declaration) => boolean])[] = [
  [DeclShape.FunctionDeclaration, ts.isFunctionDeclaration],
  [DeclShape.ArrowFunction, ts.isArrowFunction],
  [DeclShape.FunctionExpression, ts.isFunctionExpression],
  [DeclShape.MethodDeclaration, ts.isMethodDeclaration],
  [DeclShape.ConstructorDeclaration, ts.isConstructorDeclaration],
  [DeclShape.Accessor, (d) => ts.isGetAccessor(d) || ts.isSetAccessor(d)],
  [DeclShape.MethodSignature, ts.isMethodSignature],
  [DeclShape.PropertyDeclaration, ts.isPropertyDeclaration],
];

function isFunctionInitializer(node: ts.Node | undefined): boolean {
  return node !== undefined && (ts.isArrowFunction(node) || ts.isFunctionExpression(node));
}

/**
 * Return the function-shaped node that should be hashed against the
 * catalog for declaration `d`, given the caller's `accept` mask.
 * Returns null when `d` doesn't match any accepted shape.
 *
 * Variable / property assignments are unwrapped to their initializer
 * function only when the corresponding `*Initializer` bit is set.
 * Direct function-shapes are accepted only when their specific bit
 * is set — passing `DeclShape.ArrowFunction` accepts a bare arrow
 * declaration but NOT a `const foo = () => ...` (you'd need to OR
 * `VariableInitializer` for that).
 */
export function functionLikeFromDeclaration(
  d: ts.Declaration,
  accept: number,
): ts.Node | null {
  for (const [bit, predicate] of DIRECT_SHAPE_TABLE) {
    if ((accept & bit) !== 0 && predicate(d)) return d;
  }
  if (
    (accept & DeclShape.VariableInitializer) !== 0 &&
    ts.isVariableDeclaration(d) &&
    isFunctionInitializer(d.initializer)
  ) {
    return d.initializer ?? null;
  }
  if (
    (accept & DeclShape.PropertyAssignmentInitializer) !== 0 &&
    ts.isPropertyAssignment(d) &&
    isFunctionInitializer(d.initializer)
  ) {
    return d.initializer;
  }
  return null;
}
