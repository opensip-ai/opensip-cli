import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

import {
  getASTLineNumber,
  isPropertyAccess,
} from '../ast-utilities.js';

// Most TS compiler-API helpers (parseSource, walkNodes, getIdentifierName,
// getPropertyChain, isLiteral, isInStringLiteral) are tested in their
// canonical home at @opensip-tools/lang-typescript. fitness/engine keeps
// only getASTLineNumber and isPropertyAccess — those are the helpers
// exercised below. The setup inlines the TS compiler API rather than
// depending on lang-typescript directly, since the two packages are
// peers in the layered architecture.

const parse = (content: string): ts.SourceFile =>
  ts.createSourceFile('x.ts', content, ts.ScriptTarget.Latest, true);

function walk(root: ts.Node, visitor: (n: ts.Node) => void): void {
  function visit(n: ts.Node): void {
    visitor(n);
    ts.forEachChild(n, visit);
  }
  ts.forEachChild(root, visit);
}

describe('getASTLineNumber', () => {
  it('returns 1-based line numbers', () => {
    const sf = parse('\n\nconst x = 1;');
    let line = 0;
    walk(sf, (n) => {
      if (ts.isVariableDeclaration(n)) {
        line = getASTLineNumber(n, sf);
      }
    });
    expect(line).toBe(3);
  });
});

describe('isPropertyAccess', () => {
  it('matches the right property name', () => {
    const sf = parse('foo.bar();');
    let matched = false;
    walk(sf, (n) => {
      if (ts.isPropertyAccessExpression(n) && isPropertyAccess(n, 'bar')) matched = true;
    });
    expect(matched).toBe(true);
  });

  it('returns false for the wrong property name', () => {
    const sf = parse('foo.bar();');
    let matched = false;
    walk(sf, (n) => {
      if (ts.isPropertyAccessExpression(n) && isPropertyAccess(n, 'baz')) matched = true;
    });
    expect(matched).toBe(false);
  });
});
