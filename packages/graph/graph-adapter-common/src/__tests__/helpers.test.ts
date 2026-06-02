import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, afterEach, beforeEach } from 'vitest';

import { skipToEndOfLine } from '../body-digest.js';
import { hashConfig, makeConfigCacheKey } from '../cache-key.js';
import { createDiscover } from '../discover.js';
import {
  buildNameIndex,
  makeFileClassifier,
  record,
  synthesizeModuleInit,
} from '../walk.js';

import type { FunctionOccurrence } from '@opensip-tools/graph';

describe('skipToEndOfLine', () => {
  it('advances to the next newline', () => {
    expect(skipToEndOfLine('abc\ndef', 0)).toBe(3);
  });

  it('advances to end of text when no newline', () => {
    expect(skipToEndOfLine('abc', 1)).toBe(3);
  });
});

describe('hashConfig', () => {
  it('returns no-config for undefined / empty', () => {
    expect(hashConfig(undefined)).toBe('no-config');
    expect(hashConfig('')).toBe('no-config');
  });

  it('returns missing: for a nonexistent path', () => {
    expect(hashConfig('/no/such/file.toml')).toBe('missing:/no/such/file.toml');
  });

  it('returns a stable 16-hex prefix for real content', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gac-'));
    try {
      const p = join(dir, 'go.mod');
      writeFileSync(p, 'module example\n', 'utf8');
      const a = hashConfig(p);
      const b = hashConfig(p);
      expect(a).toBe(b);
      expect(a).toMatch(/^[0-9a-f]{16}$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('makeConfigCacheKey', () => {
  it('prefixes the hashConfig output', () => {
    const cacheKey = makeConfigCacheKey({ prefix: 'go' });
    expect(cacheKey({ projectDirAbs: '/p', resolutionMode: 'exact' })).toBe('go-no-config');
  });
});

describe('makeFileClassifier', () => {
  it('uses only testRe when testPathRe is absent (Go-style)', () => {
    const { isTestFile, isGeneratedFile } = makeFileClassifier({
      testRe: /_test\.go$/,
      generatedRe: /\.pb\.go$/,
    });
    expect(isTestFile('pkg/foo_test.go')).toBe(true);
    expect(isTestFile('src/test/foo.go')).toBe(false);
    expect(isGeneratedFile('foo.pb.go')).toBe(true);
  });

  it('matches either testPathRe or testRe when both supplied', () => {
    const { isTestFile } = makeFileClassifier({
      testRe: /Test\.java$/,
      generatedRe: /generated\//,
      testPathRe: /(?:^|\/)test\//,
    });
    expect(isTestFile('src/test/Foo.java')).toBe(true);
    expect(isTestFile('src/main/FooTest.java')).toBe(true);
    expect(isTestFile('src/main/Foo.java')).toBe(false);
  });
});

describe('record', () => {
  it('appends occurrences by simple name', () => {
    const out: Record<string, FunctionOccurrence[]> = Object.create(null) as Record<
      string,
      FunctionOccurrence[]
    >;
    const occ = (hash: string): FunctionOccurrence => ({
      bodyHash: hash,
      bodySize: 1,
      simpleName: 'foo',
      qualifiedName: 'm.foo',
      filePath: 'm.go',
      line: 1,
      column: 0,
      endLine: 1,
      kind: 'function-declaration',
      params: [],
      returnType: null,
      enclosingClass: null,
      decorators: [],
      visibility: 'private',
      inTestFile: false,
      definedInGenerated: false,
      calls: [],
    });
    record(out, occ('a'));
    record(out, occ('b'));
    expect(out.foo?.map((o) => o.bodyHash)).toEqual(['a', 'b']);
  });
});

describe('buildNameIndex', () => {
  it('indexes real names and skips synthetic (<…>) names', () => {
    const mk = (name: string, hash: string): FunctionOccurrence => ({
      bodyHash: hash,
      bodySize: 1,
      simpleName: name,
      qualifiedName: name,
      filePath: 'm.go',
      line: 1,
      column: 0,
      endLine: 1,
      kind: 'function-declaration',
      params: [],
      returnType: null,
      enclosingClass: null,
      decorators: [],
      visibility: 'private',
      inTestFile: false,
      definedInGenerated: false,
      calls: [],
    });
    const functions: Record<string, FunctionOccurrence[]> = {
      foo: [mk('foo', 'h1'), mk('foo', 'h2')],
      '<module-init:m.go>': [mk('<module-init:m.go>', 'h3')],
    };
    const idx = buildNameIndex(functions);
    expect(idx.get('foo')).toEqual(['h1', 'h2']);
    expect(idx.has('<module-init:m.go>')).toBe(false);
  });
});

describe('synthesizeModuleInit', () => {
  it('builds a module-init occurrence with the supplied qualifiedName', () => {
    // Minimal fake parsed file: only the fields synthesizeModuleInit reads.
    const file = {
      source: 'package main\n',
      tree: {
        rootNode: {
          children: [{ startIndex: 0, endIndex: 12 }],
          endPosition: { row: 0 },
        },
      },
    } as never;
    const occ = synthesizeModuleInit({
      file,
      filePathProjectRel: 'm.go',
      inTestFile: false,
      definedInGenerated: false,
      digestSyntheticBody: () => ({ hash: 'H', size: 9 }),
      qualifiedName: 'main/m.<module-init>',
    });
    expect(occ.kind).toBe('module-init');
    expect(occ.simpleName).toBe('<module-init:m.go>');
    expect(occ.qualifiedName).toBe('main/m.<module-init>');
    expect(occ.bodyHash).toBe('H');
    expect(occ.bodySize).toBe(9);
  });
});

describe('createDiscover', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gac-disc-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('collects matching files, excludes dirs, dedups + sorts, and resolves config', () => {
    writeFileSync(join(dir, 'go.mod'), 'module x\n', 'utf8');
    writeFileSync(join(dir, 'b.go'), 'package x\n', 'utf8');
    writeFileSync(join(dir, 'a.go'), 'package x\n', 'utf8');
    const discover = createDiscover({
      extension: 'go',
      excludedDirGlobs: ['**/vendor/**'],
      configCandidates: ['go.sum', 'go.mod'],
      languageId: 'go',
    });
    const out = discover({ cwd: dir });
    expect(out.files.length).toBe(2);
    expect([...out.files]).toEqual([...out.files].sort());
    expect(out.configPathAbs).toContain('go.mod');
  });
});
