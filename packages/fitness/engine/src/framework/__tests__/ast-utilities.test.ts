import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

import {
  getLineNumber,
  isInStringLiteral,
  isLiteral,
  isPropertyAccess,
} from '../ast-utilities.js';

// parseSource / walkNodes / getIdentifierName / getPropertyChain are tested
// in their canonical home at @opensip-tools/lang-typescript. fitness/engine
// keeps a small overlap (getLineNumber, isPropertyAccess, isLiteral,
// isInStringLiteral) — those are the helpers exercised below. The test
// setup inlines the TS compiler API rather than depending on
// lang-typescript directly, since the two packages are peers in the
// layered architecture.

const parse = (content: string): ts.SourceFile =>
  ts.createSourceFile('x.ts', content, ts.ScriptTarget.Latest, true);

function walk(root: ts.Node, visitor: (n: ts.Node) => void): void {
  function visit(n: ts.Node): void {
    visitor(n);
    ts.forEachChild(n, visit);
  }
  ts.forEachChild(root, visit);
}

describe('getLineNumber', () => {
  it('returns 1-based line numbers', () => {
    const sf = parse('\n\nconst x = 1;');
    let line = 0;
    walk(sf, (n) => {
      if (ts.isVariableDeclaration(n)) {
        line = getLineNumber(n, sf);
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

describe('isLiteral', () => {
  it.each([
    ['"hi"', true],
    ['42', true],
    ['true', true],
    ['false', true],
    ['null', true],
    ['undefined', true],
    ['x', false],
  ])('isLiteral(%s) === %s', (src, expected) => {
    const sf = parse(`(${src});`);
    let result: boolean | null = null;
    walk(sf, (n) => {
      if (ts.isParenthesizedExpression(n) && result === null) result = isLiteral(n.expression);
    });
    expect(result).toBe(expected);
  });
});

describe('isInStringLiteral', () => {
  it('returns true for nodes inside a template', () => {
    const sf = parse('const x = `${foo}`;');
    let found = false;
    walk(sf, (n) => {
      if (ts.isIdentifier(n) && n.text === 'foo' && isInStringLiteral(n)) found = true;
    });
    expect(found).toBe(true);
  });

  it('returns false for nodes outside any string', () => {
    const sf = parse('const x = 1; const y = x;');
    let found = false;
    walk(sf, (n) => {
      if (ts.isIdentifier(n) && n.text === 'y' && !isInStringLiteral(n)) found = true;
    });
    expect(found).toBe(true);
  });
});
