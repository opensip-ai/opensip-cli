import { describe, expect, it } from 'vitest';

import { pythonAdapter } from '../adapter.js';

import type { ParsedFile } from '@opensip-cli/tree-sitter';

function parse(src: string): ParsedFile {
  const tree = pythonAdapter.parse(src, 't.py');
  if (!tree) throw new Error('no tree');
  return tree;
}

const q = pythonAdapter.query!;

describe('pythonQuery (LanguageQueryAPI)', () => {
  it('is wired onto the adapter', () => {
    expect(pythonAdapter.query).toBeDefined();
  });

  it('findFunctions returns defs, methods, and anonymous lambdas', () => {
    const tree = parse(
      [
        'def top():',
        '    pass',
        'class C:',
        '    def m(self):',
        '        f = lambda x: x',
        '',
      ].join('\n'),
    );
    const names = q.findFunctions(tree).map((f) => f.name);
    expect(names).toContain('top');
    expect(names).toContain('m');
    expect(names).toContain(null); // lambda
  });

  it('findImports handles import, aliased import, from-import, and wildcard', () => {
    const tree = parse(
      [
        'import os.path',
        'import numpy as np',
        'from collections import OrderedDict, defaultdict',
        'from mod import *',
        '',
      ].join('\n'),
    );
    const imports = q.findImports(tree);
    const bySpec = new Map(imports.map((i) => [i.specifier, i.names]));
    expect(bySpec.get('os.path')).toEqual(['path']);
    expect(bySpec.get('numpy')).toEqual(['numpy']);
    expect(bySpec.get('collections')).toEqual(['OrderedDict', 'defaultdict']);
    expect(bySpec.get('mod')).toEqual([]); // wildcard contributes no names
  });

  it('findCallsTo matches identifier and attribute call targets', () => {
    const tree = parse(['def f():', '    foo()', '    obj.bar()', ''].join('\n'));
    expect(q.findCallsTo(tree, 'foo').length).toBe(1);
    expect(q.findCallsTo(tree, 'bar').length).toBe(1);
    expect(q.findCallsTo(tree, 'absent').length).toBe(0);
  });

  it('findCallsTo ignores computed/subscript callees', () => {
    const tree = parse(['def f():', '    handlers[0]()', ''].join('\n'));
    expect(q.findCallsTo(tree, 'handlers').length).toBe(0);
  });

  it('findImports handles relative from-imports', () => {
    const tree = parse(['from . import sibling', 'from .pkg import thing', ''].join('\n'));
    const imports = q.findImports(tree);
    // The relative-import marker is part of the specifier (faithful to source).
    const rel = imports.find((i) => i.names.includes('sibling'));
    expect(rel?.specifier).toBe('.');
    const pkg = imports.find((i) => i.names.includes('thing'));
    expect(pkg?.specifier).toBe('.pkg');
  });

  it('findStringLiterals returns values; getText/getLocation read nodes', () => {
    const tree = parse(['def f():', '    s = "hello"', ''].join('\n'));
    expect(q.findStringLiterals(tree).map((s) => s.value)).toContain('hello');
    const fn = q.findFunctions(tree)[0];
    expect(q.getText(tree, fn.node)).toContain('def f');
    expect(q.getLocation(tree, fn.node).line).toBe(1);
  });
});
