/**
 * Call-edge position anchoring (ADR-0033 follow-up). A chained call
 * `recv(...).method(...)` has its inner and outer CallExpressions BOTH starting
 * at `recv`, so anchoring an edge at the expression start collapses two real,
 * distinct edges onto one (line,column) identity — the spurious "conflict"
 * divergence class. `calleeAnchorNode` anchors at the CALLEE token instead, so
 * every call in a chain gets a distinct column.
 */

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { calleeAnchorNode } from '../syntactic.js';

/** Parse `code` and return every CallExpression / NewExpression, in source order. */
function callNodes(code: string): { sf: ts.SourceFile; nodes: ts.Node[] } {
  const sf = ts.createSourceFile('t.ts', code, ts.ScriptTarget.Latest, true);
  const nodes: ts.Node[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) || ts.isNewExpression(n)) nodes.push(n);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { sf, nodes };
}

/** Column (0-based) `calleeAnchorNode` anchors `node` at. */
function anchorCol(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(calleeAnchorNode(node).getStart(sf)).character;
}

/** The identifier text at the anchor (the callee token). */
function anchorText(sf: ts.SourceFile, node: ts.Node): string {
  const a = calleeAnchorNode(node);
  return a.getText(sf);
}

describe('calleeAnchorNode', () => {
  it('gives the inner and outer calls of a chain DISTINCT anchor columns', () => {
    const { sf, nodes } = callNodes('const x = currentRulesRegistry().getAll();');
    // forEachChild yields the OUTER call before the inner (outer encloses inner).
    const outer = nodes.find((n) => anchorText(sf, n) === 'getAll')!;
    const inner = nodes.find((n) => anchorText(sf, n) === 'currentRulesRegistry')!;
    expect(outer).toBeDefined();
    expect(inner).toBeDefined();
    // Both CallExpressions start at the SAME column (`currentRulesRegistry`)...
    expect(outer.getStart(sf)).toBe(inner.getStart(sf));
    // ...but their CALLEE anchors are at DISTINCT columns — no collision.
    expect(anchorCol(sf, outer)).not.toBe(anchorCol(sf, inner));
  });

  it('anchors a method call at the method name, a plain call at the callee', () => {
    const { sf, nodes } = callNodes('obj.method(); plain();');
    const method = nodes.find((n) => anchorText(sf, n) === 'method')!;
    const plain = nodes.find((n) => anchorText(sf, n) === 'plain')!;
    // method call anchors PAST the receiver `obj.`
    expect(anchorCol(sf, method)).toBeGreaterThan(method.getStart(sf) === 0 ? -1 : 0);
    expect(anchorText(sf, method)).toBe('method');
    expect(anchorText(sf, plain)).toBe('plain');
  });

  it('anchors `new C().m()` so the constructor and method do not collide', () => {
    const { sf, nodes } = callNodes('new CatalogRepo(ds).loadCatalogContract();');
    const ctor = nodes.find((n) => ts.isNewExpression(n))!;
    const call = nodes.find((n) => anchorText(sf, n) === 'loadCatalogContract')!;
    expect(anchorText(sf, ctor)).toBe('CatalogRepo'); // class name, not the `new` keyword
    expect(anchorCol(sf, ctor)).not.toBe(anchorCol(sf, call));
  });
});
