/**
 * Unit tests for the shared `createTreeSitterQuery` factory (ADR-0010, M10).
 *
 * The tree-sitter package ships no grammar (the `.wasm` lives in each `lang-*`
 * adapter), so these tests drive the factory over a hand-built minimal `Node`
 * mock that implements only the surface the factory + `nodes.ts` helpers touch:
 * `type`, `text`, `startPosition`, `namedChildren`, and `childForFieldName`.
 * The per-language extractors are supplied by the config under test, so the
 * generic traversal/assembly is exercised end-to-end. Each `lang-*` adapter
 * additionally exercises the factory through its real grammar in its own
 * `query.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import { createTreeSitterQuery, stripSurroundingQuotes } from '../query.js';

import type { Node, ParsedFile } from '../types.js';

interface MockSpec {
  readonly type: string;
  readonly text?: string;
  readonly row?: number;
  readonly column?: number;
  /** Field name → child, exposed via `childForFieldName`. */
  readonly fields?: Record<string, Node>;
  readonly children?: Node[];
}

class MockNode {
  readonly type: string;
  readonly text: string;
  readonly startPosition: { row: number; column: number };
  readonly namedChildren: (Node | null)[];
  readonly namedChildCount: number;
  private readonly fields: Record<string, Node>;

  constructor(spec: MockSpec) {
    this.type = spec.type;
    this.text = spec.text ?? '';
    this.startPosition = { row: spec.row ?? 0, column: spec.column ?? 0 };
    this.namedChildren = spec.children ?? [];
    this.namedChildCount = this.namedChildren.length;
    this.fields = spec.fields ?? {};
  }

  childForFieldName(name: string): Node | null {
    return this.fields[name] ?? null;
  }

  namedChild(i: number): Node | null {
    return this.namedChildren[i] ?? null;
  }
}

// The mock implements only the Node surface the factory + nodes.ts touch; cast
// at construction so call sites see a real `Node`.
function node(spec: MockSpec): Node {
  return new MockNode(spec) as unknown as Node;
}

/** Wrap a root node as a ParsedFile (only `.tree.rootNode` is read). */
function asTree(root: Node): ParsedFile {
  return { tree: { rootNode: root } as unknown as ParsedFile['tree'], source: '' };
}

const baseConfig = {
  functions: { nodeTypes: new Set(['fn']) },
  calls: {
    nodeTypes: new Set(['call']),
    calleeName: (n: Node): string | null => n.childForFieldName('name')?.text ?? null,
  },
  imports: {
    nodeTypes: new Set(['import']),
    extract: (n: Node) => [{ specifier: n.text, names: [n.text.split('.').pop() ?? n.text] }],
  },
  strings: { nodeTypes: new Set(['str']) },
};

describe('stripSurroundingQuotes', () => {
  it('strips matched double, single, and backtick quotes', () => {
    expect(stripSurroundingQuotes('"abc"')).toBe('abc');
    expect(stripSurroundingQuotes("'abc'")).toBe('abc');
    expect(stripSurroundingQuotes('`abc`')).toBe('abc');
  });

  it('leaves unquoted / mismatched / too-short text untouched', () => {
    expect(stripSurroundingQuotes('abc')).toBe('abc');
    expect(stripSurroundingQuotes('"abc')).toBe('"abc');
    expect(stripSurroundingQuotes('"')).toBe('"');
    expect(stripSurroundingQuotes('')).toBe('');
  });
});

describe('createTreeSitterQuery', () => {
  it('findFunctions returns each function node with its name (null when absent)', () => {
    const named = node({ type: 'fn', row: 1, fields: { name: node({ type: 'id', text: 'foo' }) } });
    const anon = node({ type: 'fn', row: 2 });
    const root = node({ type: 'root', children: [named, anon] });
    const q = createTreeSitterQuery(baseConfig);
    const fns = q.findFunctions(asTree(root));
    expect(fns.map((f) => f.name)).toEqual(['foo', null]);
    expect(fns[0].location).toEqual({ file: '', line: 2, column: 0 });
    expect(fns[0].node).toBe(named);
  });

  it('findFunctions honours a custom nameOf', () => {
    const fn = node({ type: 'fn', text: 'lambda' });
    const root = node({ type: 'root', children: [fn] });
    const q = createTreeSitterQuery({
      ...baseConfig,
      functions: { nodeTypes: new Set(['fn']), nameOf: () => null },
    });
    expect(q.findFunctions(asTree(root))[0].name).toBeNull();
  });

  it('findImports expands each import node into targets', () => {
    const imp = node({ type: 'import', text: 'a.b.C', row: 3, column: 2 });
    const root = node({ type: 'root', children: [imp] });
    const q = createTreeSitterQuery(baseConfig);
    const imports = q.findImports(asTree(root));
    expect(imports).toEqual([
      { specifier: 'a.b.C', names: ['C'], location: { file: '', line: 4, column: 2 } },
    ]);
  });

  it('findCallsTo matches the leaf callee name', () => {
    const call1 = node({ type: 'call', fields: { name: node({ type: 'id', text: 'foo' }) } });
    const call2 = node({ type: 'call', fields: { name: node({ type: 'id', text: 'bar' }) } });
    const root = node({ type: 'root', children: [call1, call2] });
    const q = createTreeSitterQuery(baseConfig);
    expect(q.findCallsTo(asTree(root), 'foo')).toEqual([call1]);
    expect(q.findCallsTo(asTree(root), 'absent')).toEqual([]);
  });

  it('findStringLiterals uses the default quote-stripping value extractor', () => {
    const str = node({ type: 'str', text: '"hello"', row: 0, column: 5 });
    const root = node({ type: 'root', children: [str] });
    const q = createTreeSitterQuery(baseConfig);
    expect(q.findStringLiterals(asTree(root))).toEqual([
      { value: 'hello', location: { file: '', line: 1, column: 5 } },
    ]);
  });

  it('findStringLiterals honours a custom stringValue', () => {
    const str = node({ type: 'str', text: 'RAW' });
    const root = node({ type: 'root', children: [str] });
    const q = createTreeSitterQuery({
      ...baseConfig,
      strings: { nodeTypes: new Set(['str']), stringValue: (n) => `<${n.text}>` },
    });
    expect(q.findStringLiterals(asTree(root))[0].value).toBe('<RAW>');
  });

  it('getLocation / getText read position and text from the node', () => {
    const n = node({ type: 'x', text: 'body', row: 7, column: 3 });
    const q = createTreeSitterQuery(baseConfig);
    const tree = asTree(node({ type: 'root' }));
    expect(q.getLocation(tree, n)).toEqual({ file: '', line: 8, column: 3 });
    expect(q.getText(tree, n)).toBe('body');
  });
});
