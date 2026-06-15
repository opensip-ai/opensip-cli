import { describe, expect, it } from 'vitest';

import { rustAdapter } from '../adapter.js';
import { stripComments, stripStrings } from '../strip.js';

describe('rustAdapter', () => {
  it('declares the expected identity and extension', () => {
    expect(rustAdapter.id).toBe('rust');
    expect(rustAdapter.fileExtensions).toContain('.rs');
    expect(rustAdapter.aliases).toContain('rs');
  });

  it('parse() returns a real tree-sitter tree + source', () => {
    const src = 'fn main() {\n  println!("hi");\n}';
    const tree = rustAdapter.parse(src, 'foo.rs');
    expect(tree).not.toBeNull();
    expect(tree?.source).toBe(src);
    expect(tree?.tree.rootNode.type).toBe('source_file');
  });
});

describe('rust stripStrings', () => {
  it('replaces regular string content but preserves length', () => {
    const src = 'let x = "hello world";';
    const out = stripStrings(src);
    expect(out.length).toBe(src.length);
    expect(out).not.toContain('hello');
    expect(out).toContain('let x =');
    expect(out).toContain('"');
  });

  it('handles raw strings r"..."', () => {
    const src = String.raw`let p = r"C:\path\to\file";`;
    const out = stripStrings(src);
    expect(out.length).toBe(src.length);
    expect(out).not.toContain('C:');
    expect(out).not.toContain('path');
  });

  it('handles raw strings with hashes r#"..."#', () => {
    const src = 'let s = r#"contains "quotes" inside"#;';
    const out = stripStrings(src);
    expect(out.length).toBe(src.length);
    expect(out).not.toContain('quotes');
    expect(out).toContain('let s =');
  });

  it('handles byte strings b"..."', () => {
    const src = 'let b = b"binary";';
    const out = stripStrings(src);
    expect(out.length).toBe(src.length);
    expect(out).not.toContain('binary');
  });

  it('preserves char literals (single chars are code, not strings)', () => {
    const src = "let c = 'x';";
    const out = stripStrings(src);
    expect(out).toBe(src);
  });

  it('preserves lifetime annotations', () => {
    const src = "fn foo<'a>(x: &'a str) {}";
    // The outer "" string body is empty; lifetimes 'a should remain
    const out = stripStrings(src);
    expect(out).toContain("'a");
  });

  it('preserves newlines inside multi-line strings', () => {
    const src = 'let x = "line1\nline2";';
    const out = stripStrings(src);
    expect(out.length).toBe(src.length);
    // Newline must survive
    expect(out.split('\n').length).toBe(src.split('\n').length);
  });
});

describe('rust stripComments', () => {
  it('replaces line comments', () => {
    const src = 'let x = 1; // a line comment';
    const out = stripComments(src);
    expect(out.length).toBe(src.length);
    expect(out).not.toContain('line comment');
    expect(out).toContain('let x = 1;');
  });

  it('replaces block comments', () => {
    const src = 'let x = /* inline */ 1;';
    const out = stripComments(src);
    expect(out.length).toBe(src.length);
    expect(out).not.toContain('inline');
    expect(out).toContain('let x =');
  });

  it('handles nested block comments', () => {
    const src = 'let x = /* outer /* inner */ outer-end */ 1;';
    const out = stripComments(src);
    expect(out.length).toBe(src.length);
    expect(out).not.toContain('outer');
    expect(out).not.toContain('inner');
    expect(out).toContain('let x =');
    expect(out).toContain('1;');
  });

  it('also strips strings', () => {
    const src = '// hi\nlet s = "secret";';
    const out = stripComments(src);
    expect(out).not.toContain('secret');
    expect(out).not.toContain('hi');
  });
});
