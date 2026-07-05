import { describe, expect, it } from 'vitest';

import { typescriptAdapter } from '../adapter.js';

describe('typescriptAdapter', () => {
  it('declares the expected identity and extensions', () => {
    expect(typescriptAdapter.id).toBe('typescript');
    expect(typescriptAdapter.fileExtensions).toContain('.ts');
    expect(typescriptAdapter.fileExtensions).toContain('.tsx');
    expect(typescriptAdapter.fileExtensions).toContain('.js');
    expect(typescriptAdapter.fileExtensions).toContain('.jsx');
  });

  it('parse() returns a non-null SourceFile for valid input', () => {
    const tree = typescriptAdapter.parse('const x = 1;', 'foo.ts');
    expect(tree).not.toBeNull();
    expect(tree?.fileName).toBe('foo.ts');
  });

  it('parse() handles broken input by returning a SourceFile (TS is forgiving)', () => {
    const tree = typescriptAdapter.parse('let x =;', 'broken.ts');
    expect(tree).not.toBeNull();
  });

  it('stripStrings replaces string content but preserves length', () => {
    const original = 'const x = "abc"; const y = 1';
    const stripped = typescriptAdapter.stripStrings(original);
    expect(stripped.length).toBe(original.length);
    expect(stripped).not.toContain('abc');
    expect(stripped).toContain('const x =');
    expect(stripped).toContain('const y = 1');
  });

  it('stripComments replaces comment content', () => {
    const original = '// hello\nconst x = 1';
    const stripped = typescriptAdapter.stripComments(original);
    expect(stripped.length).toBe(original.length);
    expect(stripped).not.toContain('hello');
    expect(stripped).toContain('const x = 1');
  });
});
