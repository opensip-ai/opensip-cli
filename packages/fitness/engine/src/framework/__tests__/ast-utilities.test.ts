import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

import {
  getIdentifierName,
  getLineNumber,
  getPropertyChain,
  isInStringLiteral,
  isLiteral,
  isPropertyAccess,
  parseSource,
  walkNodes,
} from '../ast-utilities.js';

const parse = (content: string) => parseSource(content, 'x.ts');

describe('parseSource', () => {
  it('parses valid TypeScript', () => {
    expect(parse('const x = 1;')).not.toBeNull();
  });

  it('returns null on parse failure', () => {
    expect(parseSource(undefined as unknown as string, 'x.ts')).toBeNull();
  });
});

describe('walkNodes', () => {
  it('visits every descendant node', () => {
    const sf = parse('const x = 1; const y = 2;');
    if (!sf) throw new Error('parse failed');
    let count = 0;
    walkNodes(sf, () => count++);
    expect(count).toBeGreaterThan(2);
  });
});

describe('getIdentifierName / getPropertyChain', () => {
  it('returns identifier text', () => {
    const sf = parse('foo;');
    if (!sf) throw new Error('parse failed');
    let leaf = '';
    walkNodes(sf, (n) => {
      if (ts.isIdentifier(n) && leaf === '') leaf = getIdentifierName(n);
    });
    expect(leaf).toBe('foo');
  });

  it('returns property chain', () => {
    const sf = parse('a.b.c;');
    if (!sf) throw new Error('parse failed');
    let result = '';
    walkNodes(sf, (n) => {
      if (ts.isPropertyAccessExpression(n) && result === '') result = getPropertyChain(n);
    });
    expect(result).toBe('a.b.c');
  });

  it('returns empty for non-identifier non-property nodes', () => {
    const sf = parse('1 + 2;');
    if (!sf) throw new Error('parse failed');
    let result = '';
    walkNodes(sf, (n) => {
      if (ts.isBinaryExpression(n)) {
        result = getIdentifierName(n);
      }
    });
    expect(result).toBe('');
  });

  it('getPropertyChain returns empty for non-identifier non-property', () => {
    const sf = parse('1 + 2;');
    if (!sf) throw new Error('parse failed');
    let result = '';
    walkNodes(sf, (n) => {
      if (ts.isBinaryExpression(n) && result === '') result = getPropertyChain(n);
    });
    expect(result).toBe('');
  });
});

describe('getLineNumber', () => {
  it('returns 1-based line numbers', () => {
    const sf = parse('\n\nconst x = 1;');
    if (!sf) throw new Error('parse failed');
    let line = 0;
    walkNodes(sf, (n) => {
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
    if (!sf) throw new Error('parse failed');
    let matched = false;
    walkNodes(sf, (n) => {
      if (ts.isPropertyAccessExpression(n) && isPropertyAccess(n, 'bar')) matched = true;
    });
    expect(matched).toBe(true);
  });

  it('returns false for the wrong property name', () => {
    const sf = parse('foo.bar();');
    if (!sf) throw new Error('parse failed');
    let matched = false;
    walkNodes(sf, (n) => {
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
    if (!sf) throw new Error('parse failed');
    let result: boolean | null = null;
    walkNodes(sf, (n) => {
      if (ts.isParenthesizedExpression(n) && result === null) result = isLiteral(n.expression);
    });
    expect(result).toBe(expected);
  });
});

describe('isInStringLiteral', () => {
  it('returns true for nodes inside a template', () => {
    const sf = parse('const x = `${foo}`;');
    if (!sf) throw new Error('parse failed');
    let found = false;
    walkNodes(sf, (n) => {
      if (ts.isIdentifier(n) && n.text === 'foo' && isInStringLiteral(n)) found = true;
    });
    expect(found).toBe(true);
  });

  it('returns false for nodes outside any string', () => {
    const sf = parse('const x = 1; const y = x;');
    if (!sf) throw new Error('parse failed');
    let found = false;
    walkNodes(sf, (n) => {
      if (ts.isIdentifier(n) && n.text === 'y' && !isInStringLiteral(n)) found = true;
    });
    expect(found).toBe(true);
  });
});
