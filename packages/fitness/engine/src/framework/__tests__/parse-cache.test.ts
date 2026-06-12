/**
 * @fileoverview Tests for the parse-cache shim.
 *
 * The shim forwards to the language-aware parse cache when a TypeScript
 * adapter is registered, and falls back to a direct `ts.createSourceFile`
 * parse otherwise. Both branches are exercised here.
 */

import { LanguageRegistry, RunScope, runWithScopeSync } from '@opensip-cli/core';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { getSharedSourceFile } from '../parse-cache.js';

import type { LanguageAdapter } from '@opensip-cli/core';

describe('getSharedSourceFile — fallback (no adapter registered)', () => {
  it('returns a TypeScript SourceFile for valid TS content', () => {
    const sf = getSharedSourceFile('virt.ts', 'const x: number = 1');
    expect(sf).not.toBeNull();
    expect(sf?.fileName).toBe('virt.ts');
  });

  it('returns a SourceFile for valid TSX content', () => {
    const sf = getSharedSourceFile('virt.tsx', 'const E = () => <div/>');
    expect(sf).not.toBeNull();
  });

  it('returns a SourceFile even when TS reports syntax errors (TS recovers)', () => {
    // ts.createSourceFile is permissive — it returns a partial AST rather
    // than throwing on syntax errors. The fallback should pass it through.
    const sf = getSharedSourceFile('virt.ts', 'const x = ');
    expect(sf).not.toBeNull();
  });
});

describe('getSharedSourceFile — adapter-backed cache hit', () => {
  it('routes through getParseTree when a TypeScript adapter is registered in the scope', () => {
    let parseCount = 0;
    const tsAdapter: LanguageAdapter<ts.SourceFile> = {
      id: 'typescript',
      fileExtensions: ['.ts', '.tsx'],
      parse: (content, filePath) => {
        parseCount++;
        return ts.createSourceFile(
          filePath,
          content,
          ts.ScriptTarget.Latest,
          true,
          ts.ScriptKind.TSX,
        );
      },
      stripStrings: (s) => s,
      stripComments: (s) => s,
    };
    const reg = new LanguageRegistry();
    reg.register(tsAdapter);
    const scope = new RunScope({ languages: reg });

    const sf = runWithScopeSync(scope, () => getSharedSourceFile('virt.ts', 'const x = 1'));
    expect(sf).not.toBeNull();
    expect(sf?.fileName).toBe('virt.ts');
    expect(parseCount).toBeGreaterThanOrEqual(1);
  });
});
