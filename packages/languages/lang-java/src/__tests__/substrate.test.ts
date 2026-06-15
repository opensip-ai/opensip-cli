import { RunScope, runWithScopeSync } from '@opensip-cli/core';
import { initParseCache, clearParseCache } from '@opensip-cli/core/languages/parse-cache.js';
import { walkNodes } from '@opensip-cli/tree-sitter';
import { describe, expect, it } from 'vitest';

import { findEnclosingFunction, getEnclosingFunctionName } from '../enclosing.js';
import { parseJava } from '../parse.js';
import {
  isCatch,
  isClass,
  isComment,
  isConditional,
  isConstructor,
  isFunction,
  isLoop,
  isMethod,
  isString,
} from '../predicates.js';
import { getSharedTree } from '../shared-tree.js';

import type { Node } from '@opensip-cli/tree-sitter';

const SRC = [
  'package app;',
  '// c',
  'class S {',
  '    S() {}',
  '    void m() {',
  '        String x = "h";',
  '        if (true) { return; }',
  '        for (int i = 0; i < 3; i++) {}',
  '        try { } catch (RuntimeException e) { }',
  '    }',
  '}',
  '',
].join('\n');

function root(): Node {
  const tree = parseJava(SRC, 'S.java');
  if (!tree) throw new Error('no tree');
  return tree.tree.rootNode;
}
function count(pred: (n: Node) => boolean): number {
  let n = 0;
  walkNodes(root(), (node) => {
    if (pred(node)) n++;
  });
  return n;
}

describe('java substrate', () => {
  it('predicates match the tree-sitter-java node types', () => {
    expect(count(isFunction)).toBe(2);
    expect(count(isMethod)).toBe(1);
    expect(count(isConstructor)).toBe(1);
    expect(count(isClass)).toBe(1);
    expect(count(isComment)).toBe(1);
    expect(count(isString)).toBe(1);
    expect(count(isCatch)).toBe(1);
    expect(count(isConditional)).toBe(1);
    expect(count(isLoop)).toBe(1);
  });

  it('getSharedTree caches within an active parse cache', () => {
    runWithScopeSync(new RunScope(), () => {
      initParseCache();
      try {
        const a = getSharedTree('X.java', 'class X {}');
        const b = getSharedTree('X.java', 'class X {}');
        expect(a).toBe(b);
      } finally {
        clearParseCache();
      }
    });
  });

  it('findEnclosingFunction resolves the nearest method/constructor', () => {
    const strings: Node[] = [];
    walkNodes(root(), (n) => {
      if (n.type === 'string_literal') strings.push(n);
    });
    expect(getEnclosingFunctionName(strings[0])).toBe('m');
    expect(findEnclosingFunction(strings[0])?.type).toBe('method_declaration');
  });
});
