import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import { loadGrammar, createParser, parseToTree } from '../index.js';

import type { Parser } from 'web-tree-sitter';

// The substrate is grammar-agnostic, so its tests parse with *some* grammar:
// the vendored python wasm from the sibling lang-python package, referenced by
// filesystem path (not a package import — that would add a forbidden lang-*
// dependency and is unnecessary for a file the test only needs to read).
const WASM = fileURLToPath(
  new URL('../../../languages/lang-python/wasm/tree-sitter-python.wasm', import.meta.url),
);

let parser: Parser;
beforeAll(async () => {
  parser = createParser(await loadGrammar(WASM));
});

describe('parseToTree', () => {
  it('returns a tree for valid source', () => {
    const tree = parseToTree(parser, 'x = 1\n');
    expect(tree).not.toBeNull();
    expect(tree?.rootNode.type).toBe('module');
    expect(tree?.rootNode.hasError).toBe(false);
  });

  it('returns a partial (non-null) tree with hasError for malformed source', () => {
    const tree = parseToTree(parser, 'def (:\n');
    expect(tree).not.toBeNull();
    expect(tree?.rootNode.hasError).toBe(true);
  });
});
