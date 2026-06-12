import { RunScope, runWithScopeSync } from '@opensip-cli/core';
import { initParseCache, clearParseCache } from '@opensip-cli/core/languages/parse-cache.js';
import { walkNodes } from '@opensip-cli/tree-sitter';
import { describe, expect, it } from 'vitest';

import { findEnclosingFunction, getEnclosingFunctionName } from '../enclosing.js';
import { parseGo } from '../parse.js';
import {
  isComment,
  isConditional,
  isFunction,
  isLoop,
  isMethod,
  isString,
  isStruct,
} from '../predicates.js';
import { getSharedTree } from '../shared-tree.js';

import type { Node } from '@opensip-cli/tree-sitter';

const SRC = [
  '// c',
  'package app',
  'type S struct { Name string }',
  'func (s *S) M() int {',
  '\tx := "h"',
  '\tif true {',
  '\t\treturn 1',
  '\t}',
  '\tfor i := 0; i < 3; i++ {',
  '\t}',
  '\treturn len(x)',
  '}',
  'func free() int { return 0 }',
  '',
].join('\n');

function root(): Node {
  const tree = parseGo(SRC, 's.go');
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

describe('go substrate', () => {
  it('predicates match the tree-sitter-go node types', () => {
    expect(count(isFunction)).toBe(2);
    expect(count(isMethod)).toBe(1);
    expect(count(isStruct)).toBe(1);
    expect(count(isComment)).toBe(1);
    expect(count(isString)).toBe(1);
    expect(count(isConditional)).toBe(1);
    expect(count(isLoop)).toBe(1);
  });

  it('getSharedTree caches within an active parse cache', () => {
    runWithScopeSync(new RunScope(), () => {
      initParseCache();
      try {
        const a = getSharedTree('x.go', 'package p\nfunc x() {}\n');
        const b = getSharedTree('x.go', 'package p\nfunc x() {}\n');
        expect(a).toBe(b);
      } finally {
        clearParseCache();
      }
    });
  });

  it('findEnclosingFunction resolves the nearest func/method', () => {
    const strings: Node[] = [];
    walkNodes(root(), (n) => {
      if (n.type === 'interpreted_string_literal') strings.push(n);
    });
    expect(getEnclosingFunctionName(strings[0])).toBe('M');
    expect(findEnclosingFunction(strings[0])?.type).toBe('method_declaration');
  });
});
