import { describe, expect, it } from 'vitest';

import { rustAdapter } from '../adapter.js';

import type { ParsedFile } from '@opensip-cli/tree-sitter';

function parse(src: string): ParsedFile {
  const tree = rustAdapter.parse(src, 's.rs');
  if (!tree) throw new Error('no tree');
  return tree;
}

const q = rustAdapter.query!;

describe('rustQuery (LanguageQueryAPI)', () => {
  it('is wired onto the adapter', () => {
    expect(rustAdapter.query).toBeDefined();
  });

  it('findFunctions returns free fns, methods, and anonymous closures', () => {
    const tree = parse(
      'fn free() {}\nstruct S;\nimpl S { fn m(&self) {} }\nfn uses() { let c = |x| x + 1; let _ = c(1); }\n',
    );
    const fns = q.findFunctions(tree);
    const names = fns.map((f) => f.name);
    expect(names).toContain('free');
    expect(names).toContain('m');
    expect(names).toContain('uses');
    // the closure |x| x + 1 has no name field
    expect(names).toContain(null);
  });

  it('findImports expands use-lists, aliases, wildcards, self, and extern crate', () => {
    const tree = parse(
      [
        'pub use std::collections::HashMap;',
        'use std::io::{Read, Write};',
        'use foo::bar as baz;',
        'use std::prelude::v1::*;',
        'use crate::module::{self, Helper};',
        'extern crate serde;',
      ].join('\n'),
    );
    const imports = q.findImports(tree);
    const specs = imports.map((i) => i.specifier);
    expect(specs).toContain('std::collections::HashMap');
    expect(specs).toContain('std::io::Read');
    expect(specs).toContain('std::io::Write');
    expect(specs).toContain('foo::bar');
    expect(specs).toContain('serde');
    expect(specs.some((s) => s.endsWith('::*'))).toBe(true);
    // `self` inside a use-list refers to the prefix path itself.
    expect(specs).toContain('crate::module');
    expect(specs).toContain('crate::module::Helper');

    const hashMap = imports.find((i) => i.specifier === 'std::collections::HashMap');
    expect(hashMap?.names).toEqual(['HashMap']);
  });

  it('findImports handles a bare wildcard and a glob-only use', () => {
    const tree = parse('use std::io::prelude::*;\nuse other::*;\n');
    const specs = q.findImports(tree).map((i) => i.specifier);
    expect(specs).toContain('std::io::prelude::*');
    expect(specs).toContain('other::*');
  });

  it('findCallsTo matches calls and macro invocations by leaf name', () => {
    const tree = parse('fn f() { foo(); obj.bar(); Type::make(); println!("hi"); }\n');
    expect(q.findCallsTo(tree, 'foo').length).toBe(1);
    expect(q.findCallsTo(tree, 'bar').length).toBe(1);
    expect(q.findCallsTo(tree, 'make').length).toBe(1);
    expect(q.findCallsTo(tree, 'println').length).toBe(1);
    expect(q.findCallsTo(tree, 'absent').length).toBe(0);
  });

  it('findCallsTo ignores non-named callee shapes (computed/closure calls)', () => {
    // An immediately-invoked closure has no named callee — the extractor
    // returns null, so it never matches any name.
    const tree = parse('fn f() { let arr = [foo]; arr[0](); (|| 1)(); }\n');
    expect(q.findCallsTo(tree, 'foo').length).toBe(0);
    expect(q.findCallsTo(tree, 'arr').length).toBe(0);
  });

  it('findImports handles nested scoped use-lists (prefix + path segment)', () => {
    const tree = parse('use root::{inner::{first, second}, sibling};\n');
    const specs = q
      .findImports(tree)
      .map((i) => i.specifier)
      .sort();
    expect(specs).toEqual(['root::inner::first', 'root::inner::second', 'root::sibling']);
  });

  it('findStringLiterals returns literal values; getText/getLocation read nodes', () => {
    const tree = parse('fn f() { let s = "hello"; }\n');
    const strings = q.findStringLiterals(tree);
    expect(strings.map((s) => s.value)).toContain('hello');

    const fn = q.findFunctions(tree)[0];
    expect(q.getText(tree, fn.node)).toContain('fn f()');
    expect(q.getLocation(tree, fn.node).line).toBeGreaterThanOrEqual(1);
  });
});
