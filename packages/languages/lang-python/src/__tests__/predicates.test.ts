import { walkNodes } from '@opensip-tools/tree-sitter';
import { describe, expect, it } from 'vitest';

import { parsePython } from '../parse.js';
import {
  isClass,
  isComment,
  isConditional,
  isExcept,
  isFunction,
  isLoop,
  isString,
} from '../predicates.js';

import type { Node } from '@opensip-tools/tree-sitter';

const SRC = [
  'class S:',
  '    def m(self):',
  '        # a comment',
  '        s = "hello"',
  '        if s:',
  '            for i in range(3):',
  '                try:',
  '                    pass',
  '                except ValueError:',
  '                    pass',
  '',
].join('\n');

function countMatching(pred: (n: Node) => boolean): number {
  const tree = parsePython(SRC, 't.py');
  if (!tree) throw new Error('no tree');
  let n = 0;
  walkNodes(tree.tree.rootNode, (node) => {
    if (pred(node)) n++;
  });
  return n;
}

describe('python predicates', () => {
  it('isFunction matches def; isClass matches class', () => {
    expect(countMatching(isFunction)).toBe(1);
    expect(countMatching(isClass)).toBe(1);
  });

  it('isComment and isString match', () => {
    expect(countMatching(isComment)).toBe(1);
    expect(countMatching(isString)).toBeGreaterThanOrEqual(1);
  });

  it('isExcept, isConditional, isLoop match their nodes', () => {
    expect(countMatching(isExcept)).toBe(1);
    expect(countMatching(isConditional)).toBe(1);
    expect(countMatching(isLoop)).toBe(1);
  });
});
