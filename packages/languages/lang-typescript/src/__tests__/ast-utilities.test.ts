import { describe, expect, it } from 'vitest';

import {
  countUnescapedBackticks,
  findBinaryExpressions,
  findCallExpressions,
  findEnclosingFunction,
  findEnclosingFunctionBody,
  findEnclosingScope,
  findTemplateLiterals,
  getColumn,
  getEnclosingFunctionName,
  getIdentifierName,
  getLineNumber,
  getPropertyChain,
  getSharedSourceFile,
  isAsync,
  isInAsyncContext,
  isInComment,
  isInsideConditionalBlock,
  isInStringLiteral,
  isLiteral,
  isPropertyAccess,
  parseSource,
  ts,
  walkNodes,
} from '../ast-utilities.js';

const parse = (content: string) => parseSource(content, 'x.ts');

describe('parseSource', () => {
  it('parses valid TypeScript', () => {
    expect(parse('const x = 1;')).not.toBeNull();
  });

  it('returns null on parse failure', () => {
    // Note: TS parser is permissive — try with a sentinel call that throws.
    // Most invalid syntax still produces a tree; instead exercise the catch
    // path by passing a non-string.
    // Cast to any to bypass the type guard for this test.
    const result = parseSource(undefined as unknown as string, 'x.ts');
    expect(result).toBeNull();
  });
});

describe('getSharedSourceFile', () => {
  it('returns a parsed source file', () => {
    expect(getSharedSourceFile('shared.ts', 'export const x = 1;')).not.toBeNull();
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
  it('returns the leaf identifier from an Identifier', () => {
    const sf = parse('foo;');
    if (!sf) throw new Error('parse failed');
    let leaf = '';
    walkNodes(sf, (n) => {
      if (ts.isIdentifier(n) && leaf === '') leaf = getIdentifierName(n);
    });
    expect(leaf).toBe('foo');
  });

  it('returns the property name from a PropertyAccessExpression', () => {
    const sf = parse('a.b.c;');
    if (!sf) throw new Error('parse failed');
    let result = '';
    walkNodes(sf, (n) => {
      if (ts.isPropertyAccessExpression(n) && result === '') result = getPropertyChain(n);
    });
    expect(result).toBe('a.b.c');
  });

  it('returns empty string for non-identifier non-property nodes', () => {
    const sf = parse('1 + 2;');
    if (!sf) throw new Error('parse failed');
    let found = '';
    walkNodes(sf, (n) => {
      if (ts.isBinaryExpression(n)) found = getIdentifierName(n);
    });
    expect(found).toBe('');
  });

  it('getPropertyChain returns empty for non-identifier non-property', () => {
    const sf = parse('1 + 2;');
    if (!sf) throw new Error('parse failed');
    let found = '';
    walkNodes(sf, (n) => {
      if (ts.isBinaryExpression(n) && found === '') found = getPropertyChain(n);
    });
    expect(found).toBe('');
  });
});

describe('getLineNumber / getColumn', () => {
  it('returns 1-based line and 0-based column', () => {
    const sf = parse('\n\nconst x = 1;');
    if (!sf) throw new Error('parse failed');
    let line = 0;
    let col = 0;
    walkNodes(sf, (n) => {
      if (ts.isVariableDeclaration(n)) {
        line = getLineNumber(n, sf);
        col = getColumn(n, sf);
      }
    });
    expect(line).toBe(3);
    expect(col).toBe(6); // "const " (6 chars)
  });
});

describe('isPropertyAccess', () => {
  it('matches when the property name is the right one', () => {
    const sf = parse('foo.bar();');
    if (!sf) throw new Error('parse failed');
    let matched = false;
    walkNodes(sf, (n) => {
      if (ts.isPropertyAccessExpression(n) && isPropertyAccess(n, 'bar')) matched = true;
    });
    expect(matched).toBe(true);
  });

  it('does not match when the property name differs', () => {
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
  it('returns true for nodes inside a string template', () => {
    const sf = parse('const x = `${foo}`;');
    if (!sf) throw new Error('parse failed');
    let found = false;
    walkNodes(sf, (n) => {
      if (ts.isIdentifier(n) && n.text === 'foo' && isInStringLiteral(n)) found = true;
    });
    expect(found).toBe(true);
  });

  it('returns false for nodes outside string literals', () => {
    const sf = parse('const x = 1; const y = x;');
    if (!sf) throw new Error('parse failed');
    let foundOutside = false;
    walkNodes(sf, (n) => {
      if (ts.isIdentifier(n) && n.text === 'y' && !isInStringLiteral(n)) foundOutside = true;
    });
    expect(foundOutside).toBe(true);
  });
});

describe('findCallExpressions', () => {
  it('finds matching call sites by object + method name', () => {
    const sf = parse('console.log(1); foo(); console.log(2);');
    if (!sf) throw new Error('parse failed');
    const calls = findCallExpressions(sf, 'console', 'log');
    expect(calls.length).toBe(2);
  });

  it('matches when objectName is a suffix of the property chain', () => {
    const sf = parse('a.b.console.log(1);');
    if (!sf) throw new Error('parse failed');
    const calls = findCallExpressions(sf, 'console', 'log');
    expect(calls.length).toBe(1);
  });

  it('returns empty when no matches', () => {
    const sf = parse('foo();');
    if (!sf) throw new Error('parse failed');
    expect(findCallExpressions(sf, 'console', 'log')).toEqual([]);
  });
});

describe('findBinaryExpressions', () => {
  it('finds binary expressions of the given operator kind', () => {
    const sf = parse('a + b; c - d; a + e;');
    if (!sf) throw new Error('parse failed');
    expect(findBinaryExpressions(sf, ts.SyntaxKind.PlusToken).length).toBe(2);
  });
});

describe('findTemplateLiterals', () => {
  it('finds template expressions with interpolations', () => {
    const sf = parse('const x = `${a}${b}`;');
    if (!sf) throw new Error('parse failed');
    expect(findTemplateLiterals(sf).length).toBe(1);
  });

  it('skips no-substitution templates', () => {
    const sf = parse('const x = `static`;');
    if (!sf) throw new Error('parse failed');
    expect(findTemplateLiterals(sf)).toEqual([]);
  });
});

describe('isInComment', () => {
  it('returns false for a position outside a comment', () => {
    const src = 'const x = 1;\nconst y = 2;';
    const sf = parse(src);
    if (!sf) throw new Error('parse failed');
    const xIdx = src.indexOf('const x');
    expect(isInComment(xIdx, sf)).toBe(false);
  });

  it('returns true for a position inside a leading block comment', () => {
    const src = '/* block\n   comment\n*/\nconst x = 1;';
    const sf = parse(src);
    if (!sf) throw new Error('parse failed');
    const insideIdx = src.indexOf('block');
    expect(isInComment(insideIdx, sf)).toBe(true);
  });
});

describe('countUnescapedBackticks', () => {
  it('counts unescaped backticks', () => {
    expect(countUnescapedBackticks('a `b` c')).toBe(2);
  });

  it('does not count escaped backticks', () => {
    expect(countUnescapedBackticks('a \\` b')).toBe(0);
  });

  it('returns 0 when there are none', () => {
    expect(countUnescapedBackticks('plain text')).toBe(0);
  });
});

// =============================================================================
// FUNCTION-SCOPE HELPERS (Phase D2)
// =============================================================================

/** Helper: find first descendant matching a predicate. */
function find(root: ts.Node, pred: (n: ts.Node) => boolean): ts.Node | null {
  let found: ts.Node | null = null;
  walkNodes(root, (n) => {
    if (!found && pred(n)) found = n;
  });
  return found;
}

describe('findEnclosingFunction', () => {
  it('returns the nearest function declaration', () => {
    const sf = parse('function outer() { function inner() { const x = 1; } }');
    if (!sf) throw new Error('parse failed');
    const decl = find(sf, (n) => ts.isVariableDeclaration(n) && n.name.getText(sf) === 'x');
    if (!decl) throw new Error('decl not found');
    const fn = findEnclosingFunction(decl);
    expect(fn && ts.isFunctionDeclaration(fn) && fn.name?.text).toBe('inner');
  });

  it('returns null at module scope', () => {
    const sf = parse('const x = 1;');
    if (!sf) throw new Error('parse failed');
    const decl = find(sf, ts.isVariableDeclaration);
    if (!decl) throw new Error('decl not found');
    expect(findEnclosingFunction(decl)).toBeNull();
  });

  it('returns the nearest method declaration', () => {
    const sf = parse('class C { m() { const y = 2; } }');
    if (!sf) throw new Error('parse failed');
    const decl = find(sf, (n) => ts.isVariableDeclaration(n) && n.name.getText(sf) === 'y');
    if (!decl) throw new Error('decl not found');
    const fn = findEnclosingFunction(decl);
    expect(fn && ts.isMethodDeclaration(fn)).toBe(true);
  });
});

describe('findEnclosingFunctionBody', () => {
  it('returns a Block when the function has a body block', () => {
    const sf = parse('function f() { const x = 1; }');
    if (!sf) throw new Error('parse failed');
    const decl = find(sf, ts.isVariableDeclaration);
    if (!decl) throw new Error('decl not found');
    const body = findEnclosingFunctionBody(decl);
    expect(body && ts.isBlock(body)).toBe(true);
  });

  it('returns null for arrow function with expression body', () => {
    const sf = parse('const f = () => 1 + 1;');
    if (!sf) throw new Error('parse failed');
    const arrow = find(sf, ts.isArrowFunction);
    if (!arrow || !ts.isArrowFunction(arrow)) throw new Error('arrow not found');
    // The expression body itself is the BinaryExpression `1 + 1`
    const body = findEnclosingFunctionBody(arrow.body);
    expect(body).toBeNull();
  });
});

describe('getEnclosingFunctionName', () => {
  it('returns the method name', () => {
    const sf = parse('class C { foo() { const x = 1; } }');
    if (!sf) throw new Error('parse failed');
    const decl = find(sf, ts.isVariableDeclaration);
    if (!decl) throw new Error('decl not found');
    expect(getEnclosingFunctionName(decl, sf)).toBe('foo');
  });

  it('returns the function declaration name', () => {
    const sf = parse('function bar() { const x = 1; }');
    if (!sf) throw new Error('parse failed');
    const decl = find(sf, ts.isVariableDeclaration);
    if (!decl) throw new Error('decl not found');
    expect(getEnclosingFunctionName(decl, sf)).toBe('bar');
  });

  it('returns null when there is no named ancestor', () => {
    const sf = parse('const x = 1;');
    if (!sf) throw new Error('parse failed');
    const decl = find(sf, ts.isVariableDeclaration);
    if (!decl) throw new Error('decl not found');
    expect(getEnclosingFunctionName(decl, sf)).toBeNull();
  });
});

describe('findEnclosingScope', () => {
  it('returns the SourceFile at module scope', () => {
    const sf = parse('const x = 1;');
    if (!sf) throw new Error('parse failed');
    const decl = find(sf, ts.isVariableDeclaration);
    if (!decl) throw new Error('decl not found');
    expect(findEnclosingScope(decl)).toBe(sf);
  });

  it('returns the nearest function-like ancestor', () => {
    const sf = parse('function f() { const x = 1; }');
    if (!sf) throw new Error('parse failed');
    const decl = find(sf, ts.isVariableDeclaration);
    if (!decl) throw new Error('decl not found');
    const scope = findEnclosingScope(decl);
    expect(ts.isFunctionDeclaration(scope)).toBe(true);
  });
});

describe('isAsync', () => {
  it('returns true for async function', () => {
    const sf = parse('async function f() {}');
    if (!sf) throw new Error('parse failed');
    const fn = find(sf, ts.isFunctionDeclaration);
    if (!fn) throw new Error('fn not found');
    expect(isAsync(fn)).toBe(true);
  });

  it('returns false for sync function', () => {
    const sf = parse('function g() {}');
    if (!sf) throw new Error('parse failed');
    const fn = find(sf, ts.isFunctionDeclaration);
    if (!fn) throw new Error('fn not found');
    expect(isAsync(fn)).toBe(false);
  });
});

describe('isInAsyncContext', () => {
  it('returns true inside an async function', () => {
    const sf = parse('async function f() { foo(); }');
    if (!sf) throw new Error('parse failed');
    const call = find(sf, ts.isCallExpression);
    if (!call) throw new Error('call not found');
    expect(isInAsyncContext(call)).toBe(true);
  });

  it('returns false inside a sync function', () => {
    const sf = parse('function f() { foo(); }');
    if (!sf) throw new Error('parse failed');
    const call = find(sf, ts.isCallExpression);
    if (!call) throw new Error('call not found');
    expect(isInAsyncContext(call)).toBe(false);
  });

  it('returns false at module scope', () => {
    const sf = parse('foo();');
    if (!sf) throw new Error('parse failed');
    const call = find(sf, ts.isCallExpression);
    if (!call) throw new Error('call not found');
    expect(isInAsyncContext(call)).toBe(false);
  });
});

describe('isInsideConditionalBlock', () => {
  it('returns true inside an if statement', () => {
    const sf = parse('function f() { if (x) { return 1; } }');
    if (!sf) throw new Error('parse failed');
    const ret = find(sf, ts.isReturnStatement);
    if (!ret) throw new Error('return not found');
    expect(isInsideConditionalBlock(ret)).toBe(true);
  });

  it('returns true inside a switch case', () => {
    const sf = parse('function f() { switch (x) { case 1: return 2; } }');
    if (!sf) throw new Error('parse failed');
    const ret = find(sf, ts.isReturnStatement);
    if (!ret) throw new Error('return not found');
    expect(isInsideConditionalBlock(ret)).toBe(true);
  });

  it('returns false at the top of a function body', () => {
    const sf = parse('function f() { return 1; }');
    if (!sf) throw new Error('parse failed');
    const ret = find(sf, ts.isReturnStatement);
    if (!ret) throw new Error('return not found');
    expect(isInsideConditionalBlock(ret)).toBe(false);
  });

  it('does not cross function boundaries', () => {
    const sf = parse('if (x) { function inner() { return 1; } }');
    if (!sf) throw new Error('parse failed');
    const ret = find(sf, ts.isReturnStatement);
    if (!ret) throw new Error('return not found');
    expect(isInsideConditionalBlock(ret)).toBe(false);
  });
});
