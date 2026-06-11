import { nameOf, walkNodes } from '@opensip-tools/tree-sitter';
import { describe, expect, it } from 'vitest';

import { findEnclosingFunction, getEnclosingFunctionName, isMethod } from '../enclosing.js';
import { parsePython } from '../parse.js';
import { isFunction } from '../predicates.js';

import type { Node } from '@opensip-tools/tree-sitter';

const SRC = [
  'class S:',
  '    def m(self):',
  '        def inner():',
  '            return 1',
  '        return inner()',
  '',
].join('\n');

function root(): Node {
  const tree = parsePython(SRC, 't.py');
  if (!tree) throw new Error('no tree');
  return tree.tree.rootNode;
}

describe('python enclosing helpers', () => {
  it('isMethod: a class method is true, a nested function is false', () => {
    const seen: { name: string | null; method: boolean }[] = [];
    walkNodes(root(), (n) => {
      if (isFunction(n)) seen.push({ name: nameOf(n), method: isMethod(n) });
    });
    expect(seen).toContainEqual({ name: 'm', method: true });
    expect(seen).toContainEqual({ name: 'inner', method: false });
  });

  it('findEnclosingFunction / getEnclosingFunctionName resolve the nearest def', () => {
    const innerReturns: Node[] = [];
    walkNodes(root(), (n) => {
      if (n.type === 'return_statement' && n.text.includes('1')) innerReturns.push(n);
    });
    const innerReturn = innerReturns[0];
    expect(innerReturn).toBeDefined();
    expect(getEnclosingFunctionName(innerReturn)).toBe('inner');
    expect(findEnclosingFunction(innerReturn)?.type).toBe('function_definition');
  });
});
