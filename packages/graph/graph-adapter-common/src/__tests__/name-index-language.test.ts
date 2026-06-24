/**
 * Cross-language false-edge filter: `buildNameIndex`'s `keepFile` gate +
 * `sameLanguageFileFilter`. On the single-program (exact) build the merged
 * catalog holds occurrences from every language, so a tree-sitter resolver that
 * links by SIMPLE NAME could otherwise pin a same-named occurrence from another
 * language — a false edge the per-shard build never forms. These tests pin the
 * filter to exactly that boundary.
 */

import { describe, expect, it } from 'vitest';

import { buildNameIndex, sameLanguageFileFilter } from '../walk.js';

import type { FunctionOccurrence } from '@opensip-cli/graph';

const occ = (name: string, hash: string, filePath: string): FunctionOccurrence => ({
  bodyHash: hash,
  bodySize: 1,
  simpleName: name,
  qualifiedName: name,
  filePath,
  line: 1,
  column: 0,
  endLine: 1,
  kind: 'function-declaration',
  params: [],
  returnType: null,
  enclosingClass: null,
  decorators: [],
  visibility: 'exported',
  inTestFile: false,
  definedInGenerated: false,
  calls: [],
});

describe('sameLanguageFileFilter', () => {
  it('keeps only the named language’s files (Go excludes TypeScript)', () => {
    const keep = sameLanguageFileFilter('go');
    expect(keep('pkg/foo.go')).toBe(true);
    expect(keep('pkg/foo.ts')).toBe(false);
    expect(keep('pkg/foo.tsx')).toBe(false);
    expect(keep('pkg/foo.py')).toBe(false);
  });

  it('matches by LANGUAGE, not a single extension — Python keeps .py and .pyi', () => {
    const keep = sameLanguageFileFilter('python');
    expect(keep('m/foo.py')).toBe(true);
    expect(keep('m/foo.pyi')).toBe(true);
    expect(keep('m/foo.go')).toBe(false);
    // `.pyi` must not be mistaken for `.py` truncation, and vice-versa.
    expect(keep('m/foo.pyiX')).toBe(false);
  });

  it('single-extension languages: java=.java, rust=.rs', () => {
    expect(sameLanguageFileFilter('java')('A.java')).toBe(true);
    expect(sameLanguageFileFilter('java')('A.kt')).toBe(false);
    expect(sameLanguageFileFilter('rust')('a.rs')).toBe(true);
    expect(sameLanguageFileFilter('rust')('a.go')).toBe(false);
  });

  it('fails SAFE on an unknown language — keeps everything (no edge drops)', () => {
    const keep = sameLanguageFileFilter('cobol');
    expect(keep('x.cob')).toBe(true);
    expect(keep('x.ts')).toBe(true);
  });
});

describe('buildNameIndex with a same-language filter', () => {
  // A merged exact catalog: the SAME simple name `parse` defined in a Go file and
  // a TypeScript file (different bodies → different hashes).
  const merged: Record<string, readonly FunctionOccurrence[]> = {
    parse: [occ('parse', 'GO_PARSE', 'pkg/a/parse.go'), occ('parse', 'TS_PARSE', 'pkg/b/parse.ts')],
  };

  it('Go resolution pins only the Go occurrence, never the TypeScript twin', () => {
    const byName = buildNameIndex(merged, sameLanguageFileFilter('go'));
    expect(byName.get('parse')).toEqual(['GO_PARSE']);
  });

  it('without a filter (legacy) the cross-language match leaks through', () => {
    const byName = buildNameIndex(merged);
    expect([...(byName.get('parse') ?? [])].sort()).toEqual(['GO_PARSE', 'TS_PARSE']);
  });

  it('drops the name entirely when no same-language occurrence exists', () => {
    const tsOnly: Record<string, readonly FunctionOccurrence[]> = {
      parse: [occ('parse', 'TS_PARSE', 'pkg/b/parse.ts')],
    };
    const byName = buildNameIndex(tsOnly, sameLanguageFileFilter('go'));
    expect(byName.has('parse')).toBe(false);
  });

  it('keeps multiple same-language occurrences (real overloads/dispatch survive)', () => {
    const twoGo: Record<string, readonly FunctionOccurrence[]> = {
      run: [occ('run', 'GO_A', 'a/run.go'), occ('run', 'GO_B', 'b/run.go')],
    };
    const byName = buildNameIndex(twoGo, sameLanguageFileFilter('go'));
    expect([...(byName.get('run') ?? [])].sort()).toEqual(['GO_A', 'GO_B']);
  });
});
