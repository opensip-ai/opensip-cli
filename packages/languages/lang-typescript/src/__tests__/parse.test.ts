import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { parseSource, scriptKindForFilePath } from '../parse.js';

describe('scriptKindForFilePath', () => {
  it.each([
    ['component.tsx', ts.ScriptKind.TSX],
    ['component.jsx', ts.ScriptKind.JSX],
    ['module.ts', ts.ScriptKind.TS],
    ['module.mts', ts.ScriptKind.TS],
    ['module.cts', ts.ScriptKind.TS],
    ['script.js', ts.ScriptKind.JS],
    ['script.mjs', ts.ScriptKind.JS],
    ['script.cjs', ts.ScriptKind.JS],
    ['data.json', ts.ScriptKind.JSON],
    // Unknown extensions retain the historically permissive TSX default.
    ['README.md', ts.ScriptKind.TSX],
    ['no-extension', ts.ScriptKind.TSX],
  ])('resolves %s to the expected ScriptKind', (filePath, expected) => {
    expect(scriptKindForFilePath(filePath)).toBe(expected);
  });

  it('is case-insensitive on the extension', () => {
    expect(scriptKindForFilePath('Component.TSX')).toBe(ts.ScriptKind.TSX);
    expect(scriptKindForFilePath('DATA.JSON')).toBe(ts.ScriptKind.JSON);
    expect(scriptKindForFilePath('Script.MJS')).toBe(ts.ScriptKind.JS);
  });
});

describe('parseSource', () => {
  it('parses a .js file using the JS grammar', () => {
    const sourceFile = parseSource('module.exports = { a: 1 };', 'index.js');
    expect(sourceFile).not.toBeNull();
    expect((sourceFile as (ts.SourceFile & { scriptKind: ts.ScriptKind }) | null)?.scriptKind).toBe(
      ts.ScriptKind.JS,
    );
  });

  it('parses a .json file using the JSON grammar', () => {
    const sourceFile = parseSource('{"a": 1}', 'data.json');
    expect(sourceFile).not.toBeNull();
    expect((sourceFile as (ts.SourceFile & { scriptKind: ts.ScriptKind }) | null)?.scriptKind).toBe(
      ts.ScriptKind.JSON,
    );
  });

  it('falls back to the permissive TSX grammar for an unrecognized extension', () => {
    const sourceFile = parseSource('const x = <Result>input;', 'notes.txt');
    expect(sourceFile).not.toBeNull();
    expect((sourceFile as (ts.SourceFile & { scriptKind: ts.ScriptKind }) | null)?.scriptKind).toBe(
      ts.ScriptKind.TSX,
    );
  });
});
