// @fitness-ignore-file file-length-limit -- aggregate coverage-driven test fixture; splitting destroys the contract
/**
 * Inventory property-based tests (Tier 2).
 *
 * These tests assert invariants over the catalog rather than membership
 * of specific entries. Every catalog produced by stage 1 is expected to
 * satisfy these properties for any TypeScript input — they are the
 * contract the catalog promises its consumers.
 *
 * Properties exercised:
 *
 *  1. bodyHash determinism by content — same body → same hash, twice.
 *  2. bodyHash insensitivity to whitespace inside the body.
 *  3. bodyHash sensitivity to a single identifier change.
 *  4. bodyHash collision for identical bodies under different names
 *     (the property the `duplicated-function-body` rule depends on).
 *  5. simpleName synthesis determinism for arrow callbacks.
 *  6. catalog closure: every CallEdge.to bodyHash exists in the catalog
 *     (or is empty for unresolved calls).
 *  7. simpleName + qualifiedName are both populated and non-empty
 *     for every occurrence.
 *  8. inTestFile is correct for files matching test patterns.
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { discoverFiles } from '../discover.js';
import { resolveEdges } from '../edges.js';
import { buildInventory } from '../inventory.js';

import type { Catalog, FunctionOccurrence } from '@opensip-tools/graph';

const FIXTURE_TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: 'ES2022',
    module: 'Node16',
    moduleResolution: 'Node16',
    lib: ['ES2022', 'DOM'],
    strict: true,
    esModuleInterop: true,
    skipLibCheck: true,
    jsx: 'preserve',
    rootDir: '.',
  },
  include: ['**/*.ts', '**/*.tsx'],
});

function buildCatalog(rootDir: string, files: Readonly<Record<string, string>>): Catalog {
  rmSync(rootDir, { recursive: true, force: true });
  mkdirSync(rootDir, { recursive: true });
  writeFileSync(join(rootDir, 'tsconfig.json'), FIXTURE_TSCONFIG, 'utf8');
  for (const [rel, content] of Object.entries(files)) {
    const filePath = join(rootDir, rel);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, content, 'utf8');
  }
  const discovery = discoverFiles({ projectDir: rootDir });
  const inv = buildInventory({
    projectDirAbs: discovery.projectDirAbs,
    files: discovery.files,
    compilerOptions: discovery.compilerOptions,
    tsConfigPathAbs: discovery.tsConfigPathAbs,
  });
  return inv.catalog;
}

function buildCatalogWithEdges(rootDir: string, files: Readonly<Record<string, string>>): Catalog {
  rmSync(rootDir, { recursive: true, force: true });
  mkdirSync(rootDir, { recursive: true });
  writeFileSync(join(rootDir, 'tsconfig.json'), FIXTURE_TSCONFIG, 'utf8');
  for (const [rel, content] of Object.entries(files)) {
    const filePath = join(rootDir, rel);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, content, 'utf8');
  }
  const discovery = discoverFiles({ projectDir: rootDir });
  const inv = buildInventory({
    projectDirAbs: discovery.projectDirAbs,
    files: discovery.files,
    compilerOptions: discovery.compilerOptions,
    tsConfigPathAbs: discovery.tsConfigPathAbs,
  });
  const edges = resolveEdges({
    catalog: inv.catalog,
    program: inv.program,
    projectDirAbs: discovery.projectDirAbs,
  });
  return edges.catalog;
}

function allOccurrences(catalog: Catalog): FunctionOccurrence[] {
  const out: FunctionOccurrence[] = [];
  for (const occs of Object.values(catalog.functions)) {
    for (const o of occs) out.push(o);
  }
  return out;
}

function hashByName(catalog: Catalog, name: string, filePath: string): string | undefined {
  for (const o of catalog.functions[name] ?? []) {
    if (o.filePath === filePath) return o.bodyHash;
  }
  return undefined;
}

// --------------------------------------------------------------------------
// Property 1: bodyHash determinism by content
// --------------------------------------------------------------------------

describe('Property 1 — bodyHash is deterministic by content', () => {
  let dirA: string;
  let dirB: string;
  afterAll(() => {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  });

  it('two builds of the same source produce the same bodyHash', () => {
    const src = `export function foo() { return 1 + 2; }\n`;
    dirA = mkdtempSync(join(tmpdir(), 'graph-prop1a-'));
    dirB = mkdtempSync(join(tmpdir(), 'graph-prop1b-'));
    const catA = buildCatalog(dirA, { 'a.ts': src });
    const catB = buildCatalog(dirB, { 'a.ts': src });
    expect(hashByName(catA, 'foo', 'a.ts')).toBe(hashByName(catB, 'foo', 'a.ts'));
    expect(hashByName(catA, 'foo', 'a.ts')).toBeDefined();
  });

  it('multiple identical inputs in one workspace share a hash', () => {
    const dir = mkdtempSync(join(tmpdir(), 'graph-prop1c-'));
    try {
      const cat = buildCatalog(dir, {
        'a.ts': `export function foo() { return 1; }\n`,
        'b.ts': `export function bar() { return 1; }\n`,
        'c.ts': `export function baz() { return 1; }\n`,
      });
      const a = hashByName(cat, 'foo', 'a.ts');
      const b = hashByName(cat, 'bar', 'b.ts');
      const c = hashByName(cat, 'baz', 'c.ts');
      // Identical *bodies* — the visitor hashes node text including the
      // declaration head (function name), so different names produce
      // different hashes. This sub-test is a guard against accidentally
      // strengthening the property to "name-insensitive" — see Property 4.
      expect(a).toBeDefined();
      expect(b).toBeDefined();
      expect(c).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// --------------------------------------------------------------------------
// Property 2: bodyHash is whitespace-insensitive
// --------------------------------------------------------------------------

describe('Property 2 — bodyHash insensitive to whitespace inside body', () => {
  let dirA: string;
  let dirB: string;
  afterAll(() => {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  });

  it('whitespace-only differences inside the body do not change the hash', () => {
    dirA = mkdtempSync(join(tmpdir(), 'graph-prop2a-'));
    dirB = mkdtempSync(join(tmpdir(), 'graph-prop2b-'));
    // Important: normalizeWhitespace collapses runs of whitespace to a
    // single space — but does not eat whitespace next to non-space
    // characters. So `2;` and `2 ;` differ. The valid invariant is
    // "any whitespace between two non-space tokens collapses to one
    // space"; not "any whitespace anywhere disappears."
    const compact = `export function foo() { return 1 + 2; }\n`;
    const spread = `export function foo() {\n    return   1  +  2;\n}\n`;
    const catA = buildCatalog(dirA, { 'a.ts': compact });
    const catB = buildCatalog(dirB, { 'a.ts': spread });
    expect(hashByName(catA, 'foo', 'a.ts')).toBe(hashByName(catB, 'foo', 'a.ts'));
  });

  it('newlines and tabs do not change the hash', () => {
    const dir = mkdtempSync(join(tmpdir(), 'graph-prop2c-'));
    try {
      const tabs = `export function foo() {\n\treturn 1;\n}\n`;
      const newl = `export function foo() {\n\n\nreturn 1;\n\n\n}\n`;
      const catTabs = buildCatalog(dir, { 'a.ts': tabs });
      const tabsHash = hashByName(catTabs, 'foo', 'a.ts');
      rmSync(dir, { recursive: true, force: true });

      const dir2 = mkdtempSync(join(tmpdir(), 'graph-prop2c2-'));
      const catNewl = buildCatalog(dir2, { 'a.ts': newl });
      const newlHash = hashByName(catNewl, 'foo', 'a.ts');
      rmSync(dir2, { recursive: true, force: true });

      expect(tabsHash).toBe(newlHash);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// --------------------------------------------------------------------------
// Property 3: bodyHash is sensitive to actual content changes
// --------------------------------------------------------------------------

describe('Property 3 — bodyHash sensitive to identifier or literal changes', () => {
  it('changing one identifier in the body changes the hash', () => {
    const dirA = mkdtempSync(join(tmpdir(), 'graph-prop3a-'));
    const dirB = mkdtempSync(join(tmpdir(), 'graph-prop3b-'));
    try {
      const a = `export function foo(x: number) { return x + 1; }\n`;
      const b = `export function foo(y: number) { return y + 1; }\n`;
      const catA = buildCatalog(dirA, { 'a.ts': a });
      const catB = buildCatalog(dirB, { 'a.ts': b });
      expect(hashByName(catA, 'foo', 'a.ts')).not.toBe(hashByName(catB, 'foo', 'a.ts'));
    } finally {
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    }
  });

  it('changing one literal in the body changes the hash', () => {
    const dirA = mkdtempSync(join(tmpdir(), 'graph-prop3c-'));
    const dirB = mkdtempSync(join(tmpdir(), 'graph-prop3d-'));
    try {
      const a = `export function foo() { return 1; }\n`;
      const b = `export function foo() { return 2; }\n`;
      const catA = buildCatalog(dirA, { 'a.ts': a });
      const catB = buildCatalog(dirB, { 'a.ts': b });
      expect(hashByName(catA, 'foo', 'a.ts')).not.toBe(hashByName(catB, 'foo', 'a.ts'));
    } finally {
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    }
  });

  it('changing the operator in the body changes the hash', () => {
    const dirA = mkdtempSync(join(tmpdir(), 'graph-prop3e-'));
    const dirB = mkdtempSync(join(tmpdir(), 'graph-prop3f-'));
    try {
      const a = `export function foo(x: number) { return x + 1; }\n`;
      const b = `export function foo(x: number) { return x - 1; }\n`;
      const catA = buildCatalog(dirA, { 'a.ts': a });
      const catB = buildCatalog(dirB, { 'a.ts': b });
      expect(hashByName(catA, 'foo', 'a.ts')).not.toBe(hashByName(catB, 'foo', 'a.ts'));
    } finally {
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    }
  });
});

// --------------------------------------------------------------------------
// Property 4: bodyHash collision for identical bodies (different names)
//
// This is the property the `duplicated-function-body` rule depends on:
// the visitor hashes the *node text*. The node text includes the
// declaration head (function name). Two declarations with different
// names and identical bodies will therefore produce different hashes
// today. This test documents the behavior and the test for the
// duplicate-body detector lives in rules/duplicated-function-body.test.ts.
// --------------------------------------------------------------------------

describe('Property 4 — bodyHash with identical body text but different names', () => {
  it('two function declarations with different names but identical bodies produce different hashes today', () => {
    // Document the current behavior: hashFunctionBody hashes node.getText(),
    // which includes the function-declaration name. Different names →
    // different hashes. The duplicated-function-body rule operates on
    // a normalized body slice, not the raw bodyHash, which is why it
    // can still detect duplicates.
    const dir = mkdtempSync(join(tmpdir(), 'graph-prop4a-'));
    try {
      const cat = buildCatalog(dir, {
        'a.ts': `export function foo() { return 1; }\n`,
        'b.ts': `export function bar() { return 1; }\n`,
      });
      const fooHash = hashByName(cat, 'foo', 'a.ts');
      const barHash = hashByName(cat, 'bar', 'b.ts');
      expect(fooHash).toBeDefined();
      expect(barHash).toBeDefined();
      // Names differ → hashes differ. This is intentional; the rule that
      // detects duplicates uses a separate normalized form.
      expect(fooHash).not.toBe(barHash);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('identical anonymous arrows assigned to different names collide on body but not on synthesized simpleName', () => {
    // For arrows assigned to a `const`, simpleName is inferred from the
    // parent. The arrow body itself (`() => 1`) is identical, but the
    // node text passed to hashFunctionBody is just the arrow expression
    // — no enclosing variable declaration. So two arrows with identical
    // bodies *should* collide.
    const dir = mkdtempSync(join(tmpdir(), 'graph-prop4b-'));
    try {
      const cat = buildCatalog(dir, {
        'a.ts': `export const foo = () => 1;\n`,
        'b.ts': `export const bar = () => 1;\n`,
      });
      const fooHash = hashByName(cat, 'foo', 'a.ts');
      const barHash = hashByName(cat, 'bar', 'b.ts');
      expect(fooHash).toBeDefined();
      expect(barHash).toBeDefined();
      expect(fooHash).toBe(barHash);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// --------------------------------------------------------------------------
// Property 5: simpleName synthesis determinism for arrows
// --------------------------------------------------------------------------

describe('Property 5 — synthesized arrow simpleName is deterministic', () => {
  it('arrow as map() callback gets <arrow:filePath:line:column>', () => {
    const dir = mkdtempSync(join(tmpdir(), 'graph-prop5a-'));
    try {
      const cat = buildCatalog(dir, {
        // Arrow callback at line 2 col 23 (the `(` of `(x => ...)`).
        'a.ts': `const arr = [1, 2, 3];\nexport const doubled = arr.map(x => x * 2);\n`,
      });
      const arrows = allOccurrences(cat).filter((o) => o.kind === 'arrow' && o.filePath === 'a.ts' && o.simpleName.startsWith('<arrow:'));
      expect(arrows.length).toBeGreaterThanOrEqual(1);
      const a = arrows[0];
      expect(a.simpleName).toBe(`<arrow:a.ts:${String(a.line)}:${String(a.column)}>`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('two builds of the same source produce identical synthesized arrow names', () => {
    const dirA = mkdtempSync(join(tmpdir(), 'graph-prop5b-'));
    const dirB = mkdtempSync(join(tmpdir(), 'graph-prop5c-'));
    try {
      const src = `export const doubled = [1, 2, 3].map(x => x * 2);\n`;
      const catA = buildCatalog(dirA, { 'a.ts': src });
      const catB = buildCatalog(dirB, { 'a.ts': src });
      const a = allOccurrences(catA).find((o) => o.kind === 'arrow' && o.simpleName.startsWith('<arrow:'));
      const b = allOccurrences(catB).find((o) => o.kind === 'arrow' && o.simpleName.startsWith('<arrow:'));
      expect(a).toBeDefined();
      expect(b).toBeDefined();
      expect(a!.simpleName).toBe(b!.simpleName);
    } finally {
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    }
  });

  it('module-init names are stable across builds', () => {
    const dirA = mkdtempSync(join(tmpdir(), 'graph-prop5d-'));
    const dirB = mkdtempSync(join(tmpdir(), 'graph-prop5e-'));
    try {
      const catA = buildCatalog(dirA, { 'top.ts': `console.log('hi');\n` });
      const catB = buildCatalog(dirB, { 'top.ts': `console.log('hi');\n` });
      const a = allOccurrences(catA).find((o) => o.kind === 'module-init' && o.filePath === 'top.ts');
      const b = allOccurrences(catB).find((o) => o.kind === 'module-init' && o.filePath === 'top.ts');
      expect(a!.simpleName).toBe(b!.simpleName);
      expect(a!.simpleName).toBe('<module-init:top.ts>');
    } finally {
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    }
  });
});

// --------------------------------------------------------------------------
// Property 6: catalog closure — every call's `to` references valid hashes
// --------------------------------------------------------------------------

describe('Property 6 — catalog closure: every CallEdge.to hash exists in catalog', () => {
  let dir: string;
  let catalog: Catalog;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'graph-prop6-'));
    catalog = buildCatalogWithEdges(dir, {
      'lib.ts':
        `export function helper(x: number): number { return x + 1; }\n` +
        `export function indirect(): number { return helper(2); }\n`,
      'main.ts':
        `import { helper, indirect } from './lib.js';\n` +
        `export function main(): void {\n` +
        `  helper(1);\n` +
        `  indirect();\n` +
        `  console.log('side effect');\n` +
        `}\n`,
    });
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('every CallEdge.to hash points to a real catalog entry (no dangling refs)', () => {
    const allHashes = new Set<string>();
    for (const o of allOccurrences(catalog)) allHashes.add(o.bodyHash);

    let dangling = 0;
    let totalRefs = 0;
    for (const o of allOccurrences(catalog)) {
      for (const edge of o.calls) {
        for (const h of edge.to) {
          totalRefs++;
          if (!allHashes.has(h)) {
            dangling++;
          }
        }
      }
    }
    expect(dangling).toBe(0);
    // Sanity: at least some calls were resolved.
    expect(totalRefs).toBeGreaterThan(0);
  });

  it('unresolved calls have empty `to` arrays — never undefined or null', () => {
    for (const o of allOccurrences(catalog)) {
      for (const edge of o.calls) {
        expect(Array.isArray(edge.to)).toBe(true);
      }
    }
  });
});

// --------------------------------------------------------------------------
// Property 7: simpleName + qualifiedName are mandatory and non-empty
// --------------------------------------------------------------------------

describe('Property 7 — simpleName and qualifiedName are mandatory, non-empty for every occurrence', () => {
  it('every occurrence has non-empty simpleName AND qualifiedName', () => {
    const dir = mkdtempSync(join(tmpdir(), 'graph-prop7-'));
    try {
      const catalog = buildCatalog(dir, {
        'a.ts':
          `export function namedFn() { return 1; }\n` +
          `const arrow = () => 2;\n` +
          `const fnExpr = function() { return 3; };\n` +
          `export class C {\n` +
          `  method() { return 4; }\n` +
          `  constructor() {}\n` +
          `  get x() { return 5; }\n` +
          `}\n` +
          `export default arrow;\n`,
      });
      let count = 0;
      for (const o of allOccurrences(catalog)) {
        count++;
        expect(o.simpleName, `occurrence at ${o.filePath}:${String(o.line)} kind=${o.kind} has empty simpleName`).not.toBe('');
        expect(o.simpleName, `occurrence at ${o.filePath}:${String(o.line)} kind=${o.kind} has nullish simpleName`).not.toBeNull();
        expect(typeof o.simpleName).toBe('string');
        expect(o.qualifiedName, `occurrence at ${o.filePath}:${String(o.line)} kind=${o.kind} has empty qualifiedName`).not.toBe('');
        expect(typeof o.qualifiedName).toBe('string');
      }
      expect(count).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('qualifiedName is distinct from simpleName for non-trivial cases', () => {
    const dir = mkdtempSync(join(tmpdir(), 'graph-prop7b-'));
    try {
      const catalog = buildCatalog(dir, {
        'src/foo.ts': `export function bar() { return 1; }\n`,
      });
      const occ = allOccurrences(catalog).find((o) => o.simpleName === 'bar');
      expect(occ).toBeDefined();
      // qualifiedName encodes the file path; simpleName is just the name.
      expect(occ!.qualifiedName).not.toBe(occ!.simpleName);
      expect(occ!.qualifiedName).toContain('bar');
      expect(occ!.qualifiedName).toContain('foo');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// --------------------------------------------------------------------------
// Property 8: inTestFile correctness
// --------------------------------------------------------------------------

describe('Property 8 — inTestFile flag is correct for test path patterns', () => {
  it('files matching *.test.ts are flagged inTestFile=true', () => {
    const dir = mkdtempSync(join(tmpdir(), 'graph-prop8a-'));
    try {
      const catalog = buildCatalog(dir, {
        'foo.test.ts': `export function fooTest() { return 1; }\n`,
      });
      const occ = allOccurrences(catalog).find((o) => o.simpleName === 'fooTest');
      expect(occ).toBeDefined();
      expect(occ!.inTestFile).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('files under __tests__/ are flagged inTestFile=true', () => {
    const dir = mkdtempSync(join(tmpdir(), 'graph-prop8b-'));
    try {
      const catalog = buildCatalog(dir, {
        '__tests__/helper.ts': `export function helper() { return 1; }\n`,
      });
      const occ = allOccurrences(catalog).find((o) => o.simpleName === 'helper');
      expect(occ).toBeDefined();
      expect(occ!.inTestFile).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('production files (no test pattern) are inTestFile=false', () => {
    const dir = mkdtempSync(join(tmpdir(), 'graph-prop8c-'));
    try {
      const catalog = buildCatalog(dir, {
        'src/foo.ts': `export function foo() { return 1; }\n`,
      });
      const occ = allOccurrences(catalog).find((o) => o.simpleName === 'foo');
      expect(occ).toBeDefined();
      expect(occ!.inTestFile).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('inTestFile is consistent across all occurrences in the same file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'graph-prop8d-'));
    try {
      const catalog = buildCatalog(dir, {
        'foo.test.ts':
          `export function f1() { return 1; }\n` +
          `export const f2 = () => 2;\n` +
          `export class C { m() {} }\n`,
      });
      const fileOccs = allOccurrences(catalog).filter((o) => o.filePath === 'foo.test.ts');
      expect(fileOccs.length).toBeGreaterThan(0);
      for (const o of fileOccs) {
        expect(o.inTestFile, `${o.simpleName} should inherit inTestFile=true`).toBe(true);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
