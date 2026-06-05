import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, afterEach, beforeEach } from 'vitest';

import { skipBlockComment, skipToEndOfLine } from '../body-digest.js';
import { hashConfig, makeConfigCacheKey } from '../cache-key.js';
import { createDiscover } from '../discover.js';
import { isReturnValueDiscarded } from '../return-discarded.js';
import {
  buildNameIndex,
  childrenOf,
  makeFileClassifier,
  namedChildrenOf,
  nameOf,
  record,
  synthesizeModuleInit,
} from '../walk.js';

import type { FunctionOccurrence } from '@opensip-tools/graph';
import type { Node } from '@opensip-tools/tree-sitter';

// Minimal fake of the web-tree-sitter `Node` shape `isReturnValueDiscarded`
// reads: it only ever inspects `.parent` and `.type`.
const mk = (type: string, parent: unknown = null): never =>
  ({ type, parent }) as never;

// Minimal fake of the node shape `nameOf` reads: only
// `childForFieldName('name')` and the returned node's `.text`.
const mkNameNode = (nameNode: { text: string } | null): Node =>
  ({ childForFieldName: (f: string) => (f === 'name' ? nameNode : null) }) as never;

// Minimal fake of the node shape `childrenOf` / `namedChildrenOf` read:
// only `.children` / `.namedChildren` (which web-tree-sitter types as
// `(Node | null)[]`).
const mkParent = (children: unknown[], namedChildren: unknown[]): Node =>
  ({ children, namedChildren }) as never;

describe('skipToEndOfLine', () => {
  it('advances to the next newline', () => {
    expect(skipToEndOfLine('abc\ndef', 0)).toBe(3);
  });

  it('advances to end of text when no newline', () => {
    expect(skipToEndOfLine('abc', 1)).toBe(3);
  });
});

describe('skipBlockComment', () => {
  it('returns the index just past the first `*/` (non-nesting)', () => {
    // `/*ab*/cd` — start scanning at index 2 (past the opening `/*`);
    // the closing `*/` ends at index 6.
    expect(skipBlockComment('/*ab*/cd', 2)).toBe(6);
  });

  it('does NOT nest — stops at the first `*/`, leaving an inner close dangling', () => {
    // `/* /* */ */` — start at 2. The first `*/` is the inner one at
    // index 6, so the scan returns 8, NOT the outer close. This is the
    // Go/Java/C-style non-nesting behavior.
    expect(skipBlockComment('/* /* */ */', 2)).toBe(8);
  });

  it('returns end-of-text for an unterminated block comment', () => {
    expect(skipBlockComment('/*abc', 2)).toBe(5);
  });
});

describe('nameOf', () => {
  it("returns the `name` field's text when present", () => {
    expect(nameOf(mkNameNode({ text: 'doThing' }))).toBe('doThing');
  });

  it('returns null when there is no `name` field', () => {
    expect(nameOf(mkNameNode(null))).toBeNull();
  });
});

describe('childrenOf / namedChildrenOf', () => {
  // web-tree-sitter types `.children` / `.namedChildren` as `(Node | null)[]`.
  // The helpers must drop nulls so adapters iterate a clean `Node[]`.
  it('childrenOf filters out null slots', () => {
    const a = { type: 'a' };
    const b = { type: 'b' };
    const parent = mkParent([a, null, b], []);
    expect(childrenOf(parent)).toEqual([a, b]);
  });

  it('childrenOf returns all children when none are null', () => {
    const a = { type: 'a' };
    const parent = mkParent([a], []);
    expect(childrenOf(parent)).toEqual([a]);
  });

  it('namedChildrenOf filters out null slots', () => {
    const a = { type: 'a' };
    const parent = mkParent([], [null, a, null]);
    expect(namedChildrenOf(parent)).toEqual([a]);
  });

  it('namedChildrenOf returns all named children when none are null', () => {
    const a = { type: 'a' };
    const b = { type: 'b' };
    const parent = mkParent([], [a, b]);
    expect(namedChildrenOf(parent)).toEqual([a, b]);
  });
});

describe('isReturnValueDiscarded', () => {
  it('returns true when the enclosing parent is an expression_statement', () => {
    const stmt = mk('expression_statement');
    const node = mk('call_expression', stmt);
    expect(isReturnValueDiscarded(node)).toBe(true);
  });

  it('returns false when the enclosing parent is a value-consuming node', () => {
    const parent = mk('assignment_expression');
    const node = mk('call_expression', parent);
    expect(isReturnValueDiscarded(node)).toBe(false);
  });

  it('walks transparently through parenthesized_expression wrappers', () => {
    const stmt = mk('expression_statement');
    const paren = mk('parenthesized_expression', stmt);
    const node = mk('call_expression', paren);
    expect(isReturnValueDiscarded(node)).toBe(true);
  });

  it('returns false when no enclosing parent exists (loop exit)', () => {
    const node = mk('call_expression', null);
    expect(isReturnValueDiscarded(node)).toBe(false);
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
