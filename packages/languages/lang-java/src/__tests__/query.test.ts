import { describe, expect, it } from 'vitest';

import { javaAdapter } from '../adapter.js';

import type { ParsedFile } from '@opensip-cli/tree-sitter';

function parse(src: string): ParsedFile {
  const tree = javaAdapter.parse(src, 'S.java');
  if (!tree) throw new Error('no tree');
  return tree;
}

const q = javaAdapter.query!;

describe('javaQuery (LanguageQueryAPI)', () => {
  it('is wired onto the adapter', () => {
    expect(javaAdapter.query).toBeDefined();
  });

  it('findFunctions returns methods, constructors, and anonymous lambdas', () => {
    const tree = parse(
      ['class S {', '    S() {}', '    void m() { Runnable r = () -> {}; }', '}', ''].join('\n'),
    );
    const names = q.findFunctions(tree).map((f) => f.name);
    expect(names).toContain('S'); // constructor
    expect(names).toContain('m'); // method
    expect(names).toContain(null); // lambda
  });

  it('findImports handles single-type and wildcard imports', () => {
    const tree = parse(
      ['import java.util.List;', 'import java.util.*;', 'class S {}', ''].join('\n'),
    );
    const imports = q.findImports(tree);
    const list = imports.find((i) => i.specifier === 'java.util.List');
    expect(list?.names).toEqual(['List']);
    const star = imports.find((i) => i.specifier === 'java.util.*');
    expect(star?.names).toEqual([]); // wildcard imports a package, no single name
  });

  it('findCallsTo matches method invocations and object creations', () => {
    const tree = parse(
      [
        'class S {',
        '    void m() {',
        '        foo();',
        '        obj.bar();',
        '        new Widget();',
        '    }',
        '}',
        '',
      ].join('\n'),
    );
    expect(q.findCallsTo(tree, 'foo').length).toBe(1);
    expect(q.findCallsTo(tree, 'bar').length).toBe(1);
    expect(q.findCallsTo(tree, 'Widget').length).toBe(1); // new Widget()
    expect(q.findCallsTo(tree, 'absent').length).toBe(0);
  });

  it('findCallsTo resolves a generic object creation to its raw type name', () => {
    const tree = parse(
      [
        'class S {',
        '    void m() {',
        '        var xs = new ArrayList<String>();',
        '    }',
        '}',
        '',
      ].join('\n'),
    );
    expect(q.findCallsTo(tree, 'ArrayList').length).toBe(1);
  });

  it('findStringLiterals returns values; getText/getLocation read nodes', () => {
    const tree = parse(['class S {', '    void m() { String s = "hello"; }', '}', ''].join('\n'));
    expect(q.findStringLiterals(tree).map((s) => s.value)).toContain('hello');
    const fns = q.findFunctions(tree);
    expect(q.getText(tree, fns[0].node)).toContain('void m');
    expect(q.getLocation(tree, fns[0].node).line).toBeGreaterThanOrEqual(1);
  });
});
