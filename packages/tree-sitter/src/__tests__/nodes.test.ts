import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import {
  loadGrammar,
  createParser,
  parseToTree,
  nameOf,
  childrenOf,
  namedChildrenOf,
  nodeText,
  getLineNumber,
  getColumn,
  walkNodes,
  findEnclosing,
} from '../index.js';

import type { Node, Tree } from '../index.js';

const WASM = fileURLToPath(
  new URL('../../../languages/lang-python/wasm/tree-sitter-python.wasm', import.meta.url),
);

let parse: (src: string) => Tree;
beforeAll(async () => {
  const parser = createParser(await loadGrammar(WASM));
  parse = (src) => {
    const tree = parseToTree(parser, src);
    if (!tree) throw new Error('no tree');
    return tree;
  };
});

describe('node accessors', () => {
  it('nameOf reads the name field, null when absent', () => {
    const root = parse('def foo():\n    pass\n').rootNode;
    const fn = namedChildrenOf(root)[0];
    expect(fn.type).toBe('function_definition');
    expect(nameOf(fn)).toBe('foo');
    expect(nameOf(root)).toBeNull();
  });

  it('childrenOf / namedChildrenOf return only non-null nodes', () => {
    const root = parse('x = 1\n').rootNode;
    expect(childrenOf(root).every((n: Node) => n !== null)).toBe(true);
    expect(namedChildrenOf(root).length).toBeGreaterThan(0);
  });

  it('getLineNumber is 1-based, getColumn 0-based, nodeText returns source', () => {
    const root = parse('a = 1\nb = 2\n').rootNode;
    const second = namedChildrenOf(root)[1];
    expect(getLineNumber(second)).toBe(2);
    expect(getColumn(second)).toBe(0);
    expect(nodeText(second)).toContain('b = 2');
  });

  it('walkNodes visits named descendants (function + nested return)', () => {
    const root = parse('def f():\n    return 1\n').rootNode;
    const types: string[] = [];
    walkNodes(root, (n) => types.push(n.type));
    expect(types).toContain('function_definition');
    expect(types).toContain('return_statement');
  });

  it('findEnclosing returns the nearest matching ancestor, null at root', () => {
    const root = parse('def f():\n    return 1\n').rootNode;
    const returns: Node[] = [];
    walkNodes(root, (n) => {
      if (n.type === 'return_statement') returns.push(n);
    });
    expect(returns[0]).toBeDefined();
    const fn = findEnclosing(returns[0], (n) => n.type === 'function_definition');
    expect(fn).not.toBeNull();
    expect(nameOf(fn!)).toBe('f');
    // root has no parent → no enclosing match
    expect(findEnclosing(root, () => true)).toBeNull();
  });
});
