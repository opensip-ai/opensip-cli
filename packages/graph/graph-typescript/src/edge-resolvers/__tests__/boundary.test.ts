/**
 * Cross-shard boundary-call extraction (boundary.ts).
 *
 * A boundary call is a call site whose callee name is IMPORTED but the in-shard
 * resolver did NOT resolve THIS site to a target — by construction the target
 * lives in another shard. Detection is keyed on the per-site RESOLUTION OUTCOME
 * (`resolvedEdgesByOwner`), NOT on whether the callee name exists among the
 * shard's occurrences — so a different local function sharing the name does not
 * suppress an imported call (the name-collision fix), and a site already
 * resolved in-shard is skipped (no double edge). These tests drive
 * `extractBoundaryCalls` over real `CallSiteRecord`s and assert the emitted
 * `CrossBoundaryCall` descriptors (and the cases it skips).
 */

import { ownerEdgeKey } from '@opensip-tools/graph';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { extractBoundaryCalls } from '../boundary.js';

import type { CallSiteRecord } from '../../walk.js';
import type { CallEdge } from '@opensip-tools/graph';

/**
 * Project root the boundary extractor derives `ownerFile` against. Empty string
 * resolves to cwd, so `relative('', 'm.ts')` === `'m.ts'` — matching the parsed
 * snippet's file name.
 */
const PROJECT_DIR = '';

/** No in-shard resolutions — every imported call is an unresolved boundary candidate. */
const NONE_RESOLVED: ReadonlyMap<string, readonly CallEdge[]> = new Map();

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

/**
 * Build a `resolvedEdgesByOwner` map that marks specific call-site nodes as
 * RESOLVED in-shard (to a real target), at their actual line:column — the input
 * the extractor uses to decide a site is not a boundary call.
 */
function resolvedFor(
  records: readonly CallSiteRecord[],
  nodes: readonly ts.Node[],
  ownerFile = 'm.ts',
): ReadonlyMap<string, readonly CallEdge[]> {
  const map = new Map<string, CallEdge[]>();
  for (const r of records) {
    if (!nodes.includes(r.node)) continue;
    const start = r.node.getStart(r.sourceFile);
    const lc = r.sourceFile.getLineAndCharacterOfPosition(start);
    const edge = {
      to: ['resolved-in-shard'],
      line: lc.line + 1,
      column: lc.character,
    } as unknown as CallEdge;
    const key = ownerEdgeKey(r.ownerHash, ownerFile);
    const bucket = map.get(key);
    if (bucket) bucket.push(edge);
    else map.set(key, [edge]);
  }
  return map;
}

describe('extractBoundaryCalls', () => {
  it('emits a descriptor for an imported call the shard did not resolve', () => {
    const sf = parse(
      [
        "import { helper } from './other.js';",
        'export function caller(): number {',
        '  return helper();',
        '}',
      ].join('\n'),
    );

    const out = extractBoundaryCalls(callRecords(sf), NONE_RESOLVED, PROJECT_DIR);
    expect(out).toHaveLength(1);
    const [call] = out;
    expect(call?.calleeName).toBe('helper');
    expect(call?.importSpecifier).toBe('./other.js');
    expect(call?.ownerHash).toBe('owner');
    // Owner file is derived project-relative (matches FunctionOccurrence.filePath)
    // so the cross-shard merge can key by ownerEdgeKey(ownerHash, ownerFile).
    expect(call?.ownerFile).toBe('m.ts');
    // `return helper()` — the value is used, not discarded.
    expect(call?.discarded).toBe(false);
    expect(call?.line).toBe(3);
    expect(call?.column).toBeGreaterThanOrEqual(0);
    expect(call?.text).toContain('helper');
  });

  it('marks discarded when the call is a bare ExpressionStatement', () => {
    const sf = parse(
      [
        "import { sideEffect } from './fx.js';",
        'export function run(): void {',
        '  sideEffect();',
        '}',
      ].join('\n'),
    );

    const [call] = extractBoundaryCalls(callRecords(sf), NONE_RESOLVED, PROJECT_DIR);
    expect(call?.calleeName).toBe('sideEffect');
    expect(call?.discarded).toBe(true);
  });

  it('treats an awaited bare call as discarded (unwraps await/paren)', () => {
    const sf = parse(
      [
        "import { flush } from './fx.js';",
        'export async function run(): Promise<void> {',
        '  await (flush());',
        '}',
      ].join('\n'),
    );

    const [call] = extractBoundaryCalls(callRecords(sf), NONE_RESOLVED, PROJECT_DIR);
    expect(call?.calleeName).toBe('flush');
    expect(call?.discarded).toBe(true);
  });

  it('skips a call the in-shard resolver already resolved at this site (no double edge)', () => {
    const sf = parse(
      [
        "import { helper } from './other.js';",
        'export function caller(): number {',
        '  return helper();',
        '}',
      ].join('\n'),
    );
    const records = callRecords(sf);
    // The in-shard resolver resolved THIS helper() site → not a boundary call.
    const resolved = resolvedFor(records, allCallNodes(sf));

    const out = extractBoundaryCalls(records, resolved, PROJECT_DIR);
    expect(out).toEqual([]);
  });

  it('emits even when a DIFFERENT local same-name function exists but this site is unresolved (name-collision fix)', () => {
    // A local `helper` elsewhere in the shard must NOT suppress an imported
    // `helper()` the in-shard resolver left unresolved — keyed on the per-site
    // outcome (none resolved here), not on name presence.
    const sf = parse(
      [
        "import { helper } from './other.js';",
        'export function caller(): number {',
        '  return helper();',
        '}',
      ].join('\n'),
    );

    const out = extractBoundaryCalls(callRecords(sf), NONE_RESOLVED, PROJECT_DIR);
    expect(out.map((c) => c.calleeName)).toEqual(['helper']);
  });

  it('skips a non-imported name (global / local, not a cross-module candidate)', () => {
    const sf = parse(
      [
        'export function caller(): void {',
        '  console.log(notImported());',
        '}',
        'function notImported(): number { return 1; }',
      ].join('\n'),
    );

    const out = extractBoundaryCalls(callRecords(sf), NONE_RESOLVED, PROJECT_DIR);
    expect(out).toEqual([]);
  });

  it('skips a call with no extractable simple callee name (element-access call)', () => {
    const sf = parse(
      [
        "import { table } from './t.js';",
        'export function caller(): unknown {',
        '  return table["dynamic"]();',
        '}',
      ].join('\n'),
    );

    const out = extractBoundaryCalls(callRecords(sf), NONE_RESOLVED, PROJECT_DIR);
    expect(out).toEqual([]);
  });

  it('ignores creation-kind records entirely (always intra-shard)', () => {
    const sf = parse(
      [
        "import { helper } from './other.js';",
        'export function caller(): number { return helper(); }',
      ].join('\n'),
    );

    const creationRecords: CallSiteRecord[] = allCallNodes(sf).map((node) => ({
      node,
      sourceFile: sf,
      ownerHash: 'owner',
      kind: 'creation' as const,
      childHash: 'child',
    }));

    const out = extractBoundaryCalls(creationRecords, NONE_RESOLVED, PROJECT_DIR);
    expect(out).toEqual([]);
  });

  it('skips a property-access call whose rightmost name was not itself imported', () => {
    const sf = parse(
      [
        "import { svc } from './svc.js';",
        'export function caller(): number {',
        '  return svc.method();',
        '}',
      ].join('\n'),
    );

    // The callee simple name is `method` (rightmost of `svc.method`), but
    // only `svc` carries an import specifier — `method` does not, so it is
    // not a cross-module candidate and is skipped.
    const out = extractBoundaryCalls(callRecords(sf), NONE_RESOLVED, PROJECT_DIR);
    expect(out).toEqual([]);
  });

  it('emits for an `import =` (ImportEqualsDeclaration) boundary call', () => {
    const sf = parse(
      [
        "import legacy = require('./legacy.js');",
        'export function caller(): unknown { return legacy(); }',
      ].join('\n'),
    );

    const [call] = extractBoundaryCalls(callRecords(sf), NONE_RESOLVED, PROJECT_DIR);
    expect(call?.calleeName).toBe('legacy');
    expect(call?.importSpecifier).toBe('./legacy.js');
  });

  it('truncates display text to the 80-char CallEdge contract', () => {
    const longArg = 'x'.repeat(200);
    const sf = parse(
      [
        "import { wide } from './wide.js';",
        `export function caller(): unknown { return wide("${longArg}"); }`,
      ].join('\n'),
    );

    const [call] = extractBoundaryCalls(callRecords(sf), NONE_RESOLVED, PROJECT_DIR);
    expect(call?.text.length).toBeLessThanOrEqual(80);
    expect(call?.text.endsWith('...')).toBe(true);
  });

  it('caches the import-specifier index per source file across multiple sites', () => {
    // Two imported calls in the SAME source file exercise the
    // specifierIndexBySf cache-hit branch on the second site.
    const sf = parse(
      [
        "import { a, b } from './ab.js';",
        'export function caller(): number { return a() + b(); }',
      ].join('\n'),
    );

    const out = extractBoundaryCalls(callRecords(sf), NONE_RESOLVED, PROJECT_DIR);
    expect(out.map((c) => c.calleeName).sort()).toEqual(['a', 'b']);
    for (const c of out) expect(c.importSpecifier).toBe('./ab.js');
  });
});
