/**
 * EdgeResolver contract conformance (PR-4).
 *
 * Compile-time test seam: if any edge resolver drifts from the
 * EdgeResolver signature alias, this file fails to typecheck.
 */

import { describe, expect, it } from 'vitest';

import { resolveDirectCall } from '../../edge-resolvers/direct-call.js';
import { resolveJsxElement } from '../../edge-resolvers/jsx-element.js';
import { resolveNewExpression } from '../../edge-resolvers/new-expression.js';
import { resolvePolymorphicCall } from '../../edge-resolvers/polymorphic.js';
import { resolvePropertyAccessCall } from '../../edge-resolvers/property-access.js';

import type { EdgeResolver } from '../../edge-resolvers/types.js';
import type ts from 'typescript';

const _direct: EdgeResolver<ts.CallExpression> = resolveDirectCall;
const _propAccess: EdgeResolver<ts.CallExpression> = resolvePropertyAccessCall;
const _polymorphic: EdgeResolver<ts.CallExpression> = resolvePolymorphicCall;
const _new: EdgeResolver<ts.NewExpression> = resolveNewExpression;
const _jsx: EdgeResolver<ts.JsxOpeningElement | ts.JsxSelfClosingElement> = resolveJsxElement;

// catalog-fallback intentionally has a different shape (works on
// (simpleName, catalog) → ResolverVerdict) and therefore does not
// conform to EdgeResolver.

describe('EdgeResolver contract conformance (PR-4)', () => {
  it('all resolvers implement the EdgeResolver alias at compile time', () => {
    expect(typeof _direct).toBe('function');
    expect(typeof _propAccess).toBe('function');
    expect(typeof _polymorphic).toBe('function');
    expect(typeof _new).toBe('function');
    expect(typeof _jsx).toBe('function');
  });
});
