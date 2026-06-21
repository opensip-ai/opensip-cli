import { describe, expect, it } from 'vitest';

import { goAdapter } from '../adapter.js';

import type { ParsedFile } from '@opensip-cli/tree-sitter';

function parse(src: string): ParsedFile {
  const tree = goAdapter.parse(src, 's.go');
  if (!tree) throw new Error('no tree');
  return tree;
}

const q = goAdapter.query!;

describe('goQuery (LanguageQueryAPI)', () => {
  it('is wired onto the adapter', () => {
    expect(goAdapter.query).toBeDefined();
  });

  it('findFunctions returns funcs, methods, and anonymous func literals', () => {
    const tree = parse(
      [
        'package app',
        'type S struct{}',
        'func (s S) M() {}',
        'func free() { f := func() {}; _ = f }',
        '',
      ].join('\n'),
    );
    const names = q.findFunctions(tree).map((f) => f.name);
    expect(names).toContain('M');
    expect(names).toContain('free');
    expect(names).toContain(null); // func literal
  });

  it('findImports handles single and grouped imports (names always empty)', () => {
    const tree = parse(
      ['package app', 'import "fmt"', 'import (', '\t"os"', '\talias "strings"', ')', ''].join(
        '\n',
      ),
    );
    const imports = q.findImports(tree);
    const specs = imports.map((i) => i.specifier).sort();
    expect(specs).toEqual(['fmt', 'os', 'strings']);
    expect(imports.every((i) => i.names.length === 0)).toBe(true);
  });

  it('findCallsTo matches identifier and selector call targets', () => {
    const tree = parse(['package app', 'func f() {', '\tfoo()', '\tpkg.Bar()', '}', ''].join('\n'));
    expect(q.findCallsTo(tree, 'foo').length).toBe(1);
    expect(q.findCallsTo(tree, 'Bar').length).toBe(1);
    expect(q.findCallsTo(tree, 'absent').length).toBe(0);
  });

  it('findCallsTo ignores computed callees (index-expression calls)', () => {
    const tree = parse(['package app', 'func f(fns []func()) {', '\tfns[0]()', '}', ''].join('\n'));
    expect(q.findCallsTo(tree, 'fns').length).toBe(0);
  });

  it('findStringLiterals returns values; getText/getLocation read nodes', () => {
    const tree = parse(
      ['package app', 'func f() {', '\ts := "hello"', '\t_ = s', '}', ''].join('\n'),
    );
    expect(q.findStringLiterals(tree).map((s) => s.value)).toContain('hello');
    const fn = q.findFunctions(tree)[0];
    expect(q.getText(tree, fn.node)).toContain('func f');
    expect(q.getLocation(tree, fn.node).line).toBeGreaterThanOrEqual(1);
  });
});
