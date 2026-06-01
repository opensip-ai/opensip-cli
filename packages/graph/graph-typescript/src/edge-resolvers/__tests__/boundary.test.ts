/**
 * Cross-shard boundary-call extraction (boundary.ts).
 *
 * A boundary call is a call site whose callee name is IMPORTED but is
 * NOT among the shard catalog's own occurrences — by construction the
 * target lives in another shard. These tests drive `extractBoundaryCalls`
 * over real `CallSiteRecord`s built from parsed source files and assert
 * the emitted `CrossBoundaryCall` descriptors (and the cases it skips:
 * 'creation' edges, names with no simple callee, names resolved in this
 * shard, and non-imported globals/locals).
 */

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { extractBoundaryCalls } from '../boundary.js';

import type { CallSiteRecord } from '../../walk.js';
import type { Catalog, FunctionOccurrence } from '@opensip-tools/graph';

/** Build a minimal catalog occurrence for a named function in a file. */
function occ(simpleName: string, filePath: string, hash: string): FunctionOccurrence {
  return {
    bodyHash: hash,
    simpleName,
    qualifiedName: `${filePath}.${simpleName}`,
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
  };
}

function catalogOf(...occs: FunctionOccurrence[]): Catalog {
  const functions: Record<string, FunctionOccurrence[]> = {};
  for (const o of occs) {
    const bucket = functions[o.simpleName];
    if (bucket) bucket.push(o);
    else functions[o.simpleName] = [o];
  }
  return {
    version: '3.0',
    tool: 'graph',
    language: 'typescript',
    builtAt: 'x',
    cacheKey: 'k',
    functions,
  };
}

/** Parse a snippet into a source file with parent pointers set. */
function parse(source: string): ts.SourceFile {
  return ts.createSourceFile('m.ts', source, ts.ScriptTarget.Latest, true);
}

/** Collect every call/new expression node in document order. */
function allCallNodes(sf: ts.SourceFile): ts.Node[] {
  const out: ts.Node[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) || ts.isNewExpression(n)) out.push(n);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** Wrap call nodes as 'call'-kind CallSiteRecords owned by `ownerHash`. */
function callRecords(sf: ts.SourceFile, ownerHash = 'owner'): CallSiteRecord[] {
  return allCallNodes(sf).map((node) => ({
    node,
    sourceFile: sf,
    ownerHash,
    kind: 'call' as const,
  }));
}

describe('extractBoundaryCalls', () => {
  it('emits a descriptor for an imported call absent from the shard catalog', () => {
    const sf = parse([
      "import { helper } from './other.js';",
      'export function caller(): number {',
      '  return helper();',
      '}',
    ].join('\n'));
    // The shard catalog knows `caller` but NOT `helper` (it lives in
    // another shard).
    const catalog = catalogOf(occ('caller', 'm.ts', 'owner'));

    const out = extractBoundaryCalls(callRecords(sf), catalog);
    expect(out).toHaveLength(1);
    const [call] = out;
    expect(call?.calleeName).toBe('helper');
    expect(call?.importSpecifier).toBe('./other.js');
    expect(call?.ownerHash).toBe('owner');
    // `return helper()` — the value is used, not discarded.
    expect(call?.discarded).toBe(false);
    expect(call?.line).toBe(3);
    expect(call?.column).toBeGreaterThanOrEqual(0);
    expect(call?.text).toContain('helper');
  });

  it('marks discarded when the call is a bare ExpressionStatement', () => {
    const sf = parse([
      "import { sideEffect } from './fx.js';",
      'export function run(): void {',
      '  sideEffect();',
      '}',
    ].join('\n'));
    const catalog = catalogOf(occ('run', 'm.ts', 'owner'));

    const [call] = extractBoundaryCalls(callRecords(sf), catalog);
    expect(call?.calleeName).toBe('sideEffect');
    expect(call?.discarded).toBe(true);
  });

  it('treats an awaited bare call as discarded (unwraps await/paren)', () => {
    const sf = parse([
      "import { flush } from './fx.js';",
      'export async function run(): Promise<void> {',
      '  await (flush());',
      '}',
    ].join('\n'));
    const catalog = catalogOf(occ('run', 'm.ts', 'owner'));

    const [call] = extractBoundaryCalls(callRecords(sf), catalog);
    expect(call?.calleeName).toBe('flush');
    expect(call?.discarded).toBe(true);
  });

  it('skips a call whose callee name IS among the shard occurrences (intra-shard)', () => {
    const sf = parse([
      "import { helper } from './other.js';",
      'export function caller(): number {',
      '  return helper();',
      '}',
    ].join('\n'));
    // This time the shard DOES own `helper` → not a boundary call.
    const catalog = catalogOf(occ('caller', 'm.ts', 'owner'), occ('helper', 'm.ts', 'h2'));

    const out = extractBoundaryCalls(callRecords(sf), catalog);
    expect(out).toEqual([]);
  });

  it('skips a non-imported name (global / local, not a cross-module candidate)', () => {
    const sf = parse([
      'export function caller(): void {',
      '  console.log(notImported());',
      '}',
      'function notImported(): number { return 1; }',
    ].join('\n'));
    // Neither `log` nor `notImported` is imported → no boundary calls,
    // even though `log`/`notImported` are absent from the catalog.
    const catalog = catalogOf(occ('caller', 'm.ts', 'owner'));

    const out = extractBoundaryCalls(callRecords(sf), catalog);
    expect(out).toEqual([]);
  });

  it('skips a call with no extractable simple callee name (element-access call)', () => {
    const sf = parse([
      "import { table } from './t.js';",
      'export function caller(): unknown {',
      '  return table["dynamic"]();',
      '}',
    ].join('\n'));
    const catalog = catalogOf(occ('caller', 'm.ts', 'owner'));

    // `table["dynamic"]()` has no simple callee name → calleeSimpleName
    // returns null → skipped.
    const out = extractBoundaryCalls(callRecords(sf), catalog);
    expect(out).toEqual([]);
  });

  it('ignores creation-kind records entirely (always intra-shard)', () => {
    const sf = parse([
      "import { helper } from './other.js';",
      'export function caller(): number { return helper(); }',
    ].join('\n'));
    const catalog = catalogOf(occ('caller', 'm.ts', 'owner'));

    const creationRecords: CallSiteRecord[] = allCallNodes(sf).map((node) => ({
      node,
      sourceFile: sf,
      ownerHash: 'owner',
      kind: 'creation' as const,
      childHash: 'child',
    }));

    const out = extractBoundaryCalls(creationRecords, catalog);
    expect(out).toEqual([]);
  });

  it('skips a property-access call whose rightmost name was not itself imported', () => {
    const sf = parse([
      "import { svc } from './svc.js';",
      'export function caller(): number {',
      '  return svc.method();',
      '}',
    ].join('\n'));
    const catalog = catalogOf(occ('caller', 'm.ts', 'owner'));

    // The callee simple name is `method` (rightmost of `svc.method`), but
    // only `svc` carries an import specifier — `method` does not, so it is
    // not a cross-module candidate and is skipped.
    const out = extractBoundaryCalls(callRecords(sf), catalog);
    expect(out).toEqual([]);
  });

  it('emits for an `import =` (ImportEqualsDeclaration) boundary call', () => {
    const sf = parse([
      "import legacy = require('./legacy.js');",
      'export function caller(): unknown { return legacy(); }',
    ].join('\n'));
    const catalog = catalogOf(occ('caller', 'm.ts', 'owner'));

    const [call] = extractBoundaryCalls(callRecords(sf), catalog);
    expect(call?.calleeName).toBe('legacy');
    expect(call?.importSpecifier).toBe('./legacy.js');
  });

  it('truncates display text to the 80-char CallEdge contract', () => {
    const longArg = 'x'.repeat(200);
    const sf = parse([
      "import { wide } from './wide.js';",
      `export function caller(): unknown { return wide("${longArg}"); }`,
    ].join('\n'));
    const catalog = catalogOf(occ('caller', 'm.ts', 'owner'));

    const [call] = extractBoundaryCalls(callRecords(sf), catalog);
    expect(call?.text.length).toBeLessThanOrEqual(80);
    expect(call?.text.endsWith('...')).toBe(true);
  });

  it('caches the import-specifier index per source file across multiple sites', () => {
    // Two imported calls in the SAME source file exercise the
    // specifierIndexBySf cache-hit branch on the second site.
    const sf = parse([
      "import { a, b } from './ab.js';",
      'export function caller(): number { return a() + b(); }',
    ].join('\n'));
    const catalog = catalogOf(occ('caller', 'm.ts', 'owner'));

    const out = extractBoundaryCalls(callRecords(sf), catalog);
    expect(out.map((c) => c.calleeName).sort()).toEqual(['a', 'b']);
    for (const c of out) expect(c.importSpecifier).toBe('./ab.js');
  });
});
