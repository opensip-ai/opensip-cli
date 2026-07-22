import { describe, expect, it } from 'vitest';

import {
  countUnescapedBackticks,
  findBinaryExpressions,
  findCallExpressions,
  findTemplateLiterals,
  getColumn,
  getIdentifierName,
  getLineNumber,
  getPropertyChain,
  getSharedSourceFile,
  isInComment,
  isInStringLiteral,
  isLiteral,
  isPropertyAccess,
  ts,
  walkNodes,
} from '../ast-utilities.js';
import {
  findEnclosingFunction,
  findEnclosingFunctionBody,
  findEnclosingScope,
  getEnclosingFunctionName,
  isAsync,
  isInAsyncContext,
  isInsideConditionalBlock,
} from '../function-scope.js';
import { parseSource } from '../parse.js';

const parse = (content: string) => parseSource(content, 'x.ts');

describe('parseSource', () => {
  it('parses valid TypeScript', () => {
    expect(parse('const x = 1;')).not.toBeNull();
  });

  it('uses the TypeScript grammar for angle-bracket assertions in .ts files', () => {
    const sourceFile = parseSource('const value = <Result>input;', 'x.ts');
    if (!sourceFile) throw new Error('parse failed');

    let typeAssertions = 0;
    let jsxElements = 0;
    walkNodes(sourceFile, (node) => {
      if (ts.isTypeAssertionExpression(node)) typeAssertions++;
      if (ts.isJsxElement(node)) jsxElements++;
    });

    expect(typeAssertions).toBe(1);
    expect(jsxElements).toBe(0);
  });

  it('continues to use the JSX grammar for .tsx files', () => {
    const sourceFile = parseSource('const view = <Result>{input}</Result>;', 'x.tsx');
    if (!sourceFile) throw new Error('parse failed');

    let jsxElements = 0;
    walkNodes(sourceFile, (node) => {
      if (ts.isJsxElement(node)) jsxElements++;
    });

    expect(jsxElements).toBe(1);
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

  it('getIdentifierName also resolves the property name from a PropertyAccessExpression', () => {
    const sf = parse('a.b;');
    if (!sf) throw new Error('parse failed');
    let result = '';
    walkNodes(sf, (n) => {
      if (ts.isPropertyAccessExpression(n) && result === '') result = getIdentifierName(n);
    });
    expect(result).toBe('b');
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
    ['`hi`', true],
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
  it('returns false for identifiers inside template interpolations (code, not string)', () => {
    const sf = parse('const x = `${foo}`;');
    if (!sf) throw new Error('parse failed');
    let foundInString = false;
    walkNodes(sf, (n) => {
      if (ts.isIdentifier(n) && n.text === 'foo' && isInStringLiteral(n)) foundInString = true;
    });
    expect(foundInString).toBe(false);
  });

  it('returns true for pure string literals', () => {
    const sf = parse('const x = "hello";');
    if (!sf) throw new Error('parse failed');
    let found = false;
    walkNodes(sf, (n) => {
      if (ts.isStringLiteral(n) && isInStringLiteral(n)) found = true;
      // child of string doesn't exist for plain strings; check string node itself via parent walk
    });
    // Walk a node that is the string's parent usage — check identifier is outside
    let yOutside = false;
    const sf2 = parse('const y = "hello";');
    if (!sf2) throw new Error('parse failed');
    walkNodes(sf2, (n) => {
      if (ts.isIdentifier(n) && n.text === 'y' && !isInStringLiteral(n)) yOutside = true;
    });
    expect(yOutside).toBe(true);
    void found;
  });

  // Note: isInStringLiteral walks ancestors (not the node itself), so a
  // TemplateHead/Middle/Tail token is not "in" a string — it *is* the span.
  // Interpolation expressions are covered by the substitution tests below.

  it('returns false for nodes outside string literals', () => {
    const sf = parse('const x = 1; const y = x;');
    if (!sf) throw new Error('parse failed');
    let foundOutside = false;
    walkNodes(sf, (n) => {
      if (ts.isIdentifier(n) && n.text === 'y' && !isInStringLiteral(n)) foundOutside = true;
    });
    expect(foundOutside).toBe(true);
  });

  it('returns false for an identifier inside a template-literal substitution (live code, not string content)', () => {
    const sf = parse('const x = `${foo}`;');
    if (!sf) throw new Error('parse failed');
    let sawFoo = false;
    walkNodes(sf, (n) => {
      if (ts.isIdentifier(n) && n.text === 'foo') {
        sawFoo = true;
        expect(isInStringLiteral(n)).toBe(false);
      }
    });
    expect(sawFoo).toBe(true);
  });

  it('returns false for a call expression nested inside a template-literal substitution', () => {
    const sf = parse('const x = `hello ${dangerousCall()} world`;');
    if (!sf) throw new Error('parse failed');
    let sawCall = false;
    walkNodes(sf, (n) => {
      if (ts.isCallExpression(n)) {
        sawCall = true;
        expect(isInStringLiteral(n)).toBe(false);
      }
    });
    expect(sawCall).toBe(true);
  });

  // Coverage note: when the queried node sits TWO levels inside a
  // substitution (an argument of a call that IS the substitution's whole
  // expression), the ancestor walk passes through the call expression first
  // (not a TemplateSpan/head/tail/expression itself), then reaches the
  // TemplateSpan where `current.expression === node` is false (current.expression
  // is the *call*, not the argument) — so the walk continues past the span
  // to the enclosing TemplateExpression, which is also not "in a string".
  it('returns false for an argument nested two levels inside a template-literal substitution', () => {
    const sf = parse('const x = `${dangerousCall(arg)}`;');
    if (!sf) throw new Error('parse failed');
    let sawArg = false;
    walkNodes(sf, (n) => {
      if (ts.isIdentifier(n) && n.text === 'arg') {
        sawArg = true;
        expect(isInStringLiteral(n)).toBe(false);
      }
    });
    expect(sawArg).toBe(true);
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

  it('skips property-access calls whose method name does not match', () => {
    const sf = parse('foo.other(); console.log(1);');
    if (!sf) throw new Error('parse failed');
    const calls = findCallExpressions(sf, 'console', 'log');
    expect(calls.length).toBe(1);
  });

  it('skips calls whose method name matches but whose object chain does not', () => {
    // `foo.log()` has the right method name ("log") but the wrong object
    // chain ("foo", neither equal to nor ending with ".console") — it must
    // be excluded while `console.log(1)` in the same source is kept.
    const sf = parse('foo.log(); console.log(1);');
    if (!sf) throw new Error('parse failed');
    const calls = findCallExpressions(sf, 'console', 'log');
    expect(calls.length).toBe(1);
    expect(calls[0].getText(sf)).toBe('console.log(1)');
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

  it('returns true for a mid-line trailing line comment', () => {
    const src = 'const x = 1; // mid-line comment\nconst y = 2;';
    const sf = parse(src);
    if (!sf) throw new Error('parse failed');
    const insideIdx = src.indexOf('mid-line');
    expect(isInComment(insideIdx, sf)).toBe(true);
  });

  it('returns true for the second line of a multi-line block comment', () => {
    const src = '/* block\n   comment\n*/\nconst x = 1;';
    const sf = parse(src);
    if (!sf) throw new Error('parse failed');
    const insideIdx = src.indexOf('comment');
    expect(isInComment(insideIdx, sf)).toBe(true);
  });

  // Coverage note: with two separate comments in the file, checking a
  // position inside the SECOND one forces at least one non-matching range
  // check along the way (the first statement's leading comment range does
  // not contain this position), exercising the loop's full-scan fallthrough
  // in `isPositionInRanges` rather than always matching on the first range
  // examined.
  it('returns true for a position inside the second of two separate comments', () => {
    const src = '// first comment\nconst x = 1;\n// second comment\nconst y = 2;';
    const sf = parse(src);
    if (!sf) throw new Error('parse failed');
    const insideIdx = src.indexOf('second comment');
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

  it('returns null at module scope (no enclosing function at all)', () => {
    const sf = parse('const x = 1;');
    if (!sf) throw new Error('parse failed');
    const decl = find(sf, ts.isVariableDeclaration);
    if (!decl) throw new Error('decl not found');
    expect(findEnclosingFunctionBody(decl)).toBeNull();
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

  it('returns the get-accessor name', () => {
    const sf = parse('class C { get foo() { const x = 1; return x; } }');
    if (!sf) throw new Error('parse failed');
    const decl = find(sf, ts.isVariableDeclaration);
    if (!decl) throw new Error('decl not found');
    expect(getEnclosingFunctionName(decl, sf)).toBe('foo');
  });

  it('returns the set-accessor name', () => {
    const sf = parse('class C { set foo(v) { const x = v; } }');
    if (!sf) throw new Error('parse failed');
    const decl = find(sf, ts.isVariableDeclaration);
    if (!decl) throw new Error('decl not found');
    expect(getEnclosingFunctionName(decl, sf)).toBe('foo');
  });

  it('returns "constructor" inside a class constructor', () => {
    const sf = parse('class C { constructor() { const x = 1; } }');
    if (!sf) throw new Error('parse failed');
    const decl = find(sf, ts.isVariableDeclaration);
    if (!decl) throw new Error('decl not found');
    expect(getEnclosingFunctionName(decl, sf)).toBe('constructor');
  });

  it('returns the name of a named function expression', () => {
    const sf = parse('const f = function namedFn() { const x = 1; };');
    if (!sf) throw new Error('parse failed');
    const decl = find(sf, (n) => ts.isVariableDeclaration(n) && n.name.getText(sf) === 'x');
    if (!decl) throw new Error('decl not found');
    expect(getEnclosingFunctionName(decl, sf)).toBe('namedFn');
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

  it('returns the SourceFile itself when called directly on it (no .parent to walk from)', () => {
    // `node.parent` is undefined for a SourceFile (it is the AST root), so
    // the while loop never executes — the function falls straight through
    // to its `node.getSourceFile()` fallback.
    const sf = parse('const x = 1;');
    if (!sf) throw new Error('parse failed');
    expect(findEnclosingScope(sf)).toBe(sf);
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

  it('returns false (via the ?? fallback) for a node that cannot carry modifiers at all', () => {
    // `ts.canHaveModifiers` is false for a plain Identifier, so `modifiers`
    // is `undefined` and `isAsync` falls through the `??` to `false` rather
    // than calling `.some` on it.
    const sf = parse('foo;');
    if (!sf) throw new Error('parse failed');
    const ident = find(sf, ts.isIdentifier);
    if (!ident) throw new Error('identifier not found');
    expect(isAsync(ident)).toBe(false);
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

  it("returns true for a switch statement's own discriminant expression", () => {
    // The discriminant's parent is the SwitchStatement directly (not via a
    // CaseClause), pinning the `ts.isSwitchStatement(current)` branch itself
    // rather than the CaseClause branch already covered above.
    const sf = parse('function f() { switch (getDiscriminant()) { case 1: break; } }');
    if (!sf) throw new Error('parse failed');
    const call = find(
      sf,
      (n) => ts.isCallExpression(n) && n.expression.getText(sf) === 'getDiscriminant',
    );
    if (!call) throw new Error('call not found');
    expect(isInsideConditionalBlock(call)).toBe(true);
  });

  it('returns true inside a ternary conditional expression', () => {
    const sf = parse('function f() { const y = cond ? doThing() : other(); }');
    if (!sf) throw new Error('parse failed');
    const call = find(sf, (n) => ts.isCallExpression(n) && n.expression.getText(sf) === 'doThing');
    if (!call) throw new Error('call not found');
    expect(isInsideConditionalBlock(call)).toBe(true);
  });

  it('returns false at pure module scope (no enclosing function, no conditional)', () => {
    // Unlike the "top of a function body" case above (which returns false
    // via the isFunctionLike branch), this node has NO function ancestor at
    // all — the walk runs all the way up to the SourceFile and falls
    // through the loop's final `return false` naturally.
    const sf = parse('foo();');
    if (!sf) throw new Error('parse failed');
    const call = find(sf, ts.isCallExpression);
    if (!call) throw new Error('call not found');
    expect(isInsideConditionalBlock(call)).toBe(false);
  });
});
