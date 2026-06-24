import { describe, expect, it } from 'vitest';

import { languageOfFile } from '../language-of-file.js';

describe('languageOfFile', () => {
  it('maps TypeScript extensions', () => {
    expect(languageOfFile('src/a.ts')).toBe('typescript');
    expect(languageOfFile('src/a.tsx')).toBe('typescript');
    expect(languageOfFile('src/a.mts')).toBe('typescript');
    expect(languageOfFile('src/a.cts')).toBe('typescript');
  });

  it('maps JavaScript extensions to typescript (same adapter; .ts↔.js clones are real)', () => {
    expect(languageOfFile('src/a.js')).toBe('typescript');
    expect(languageOfFile('src/a.jsx')).toBe('typescript');
    expect(languageOfFile('src/a.mjs')).toBe('typescript');
    expect(languageOfFile('src/a.cjs')).toBe('typescript');
    // A .ts and a .js file are the same language → clones between them are detected.
    expect(languageOfFile('a.ts')).toBe(languageOfFile('b.js'));
  });

  it('maps Python extensions without truncating .pyi', () => {
    expect(languageOfFile('mod.py')).toBe('python');
    expect(languageOfFile('stub.pyi')).toBe('python');
  });

  it('maps Go, Java, and Rust', () => {
    expect(languageOfFile('main.go')).toBe('go');
    expect(languageOfFile('App.java')).toBe('java');
    expect(languageOfFile('lib.rs')).toBe('rust');
  });

  it('returns undefined for unknown extensions', () => {
    expect(languageOfFile('readme.md')).toBeUndefined();
    expect(languageOfFile('noext')).toBeUndefined();
  });

  it('two files share a language iff languageOfFile is equal', () => {
    expect(languageOfFile('a.ts')).toBe(languageOfFile('b.tsx'));
    expect(languageOfFile('a.go')).not.toBe(languageOfFile('b.ts'));
  });
});
