/**
 * GraphLanguageAdapter contract test suite.
 *
 * Validates each of the 9 behavioral invariants (I-1 through I-9)
 * defined in docs/plans/11-graph-language-adapter-contract.md §3
 * against `typescriptGraphAdapter`. Future adapter PRs add `describe`
 * blocks against their own fixtures referencing the same invariants.
 *
 * Each test names the invariant it covers in the title so reviewers
 * can map a failure straight to the contract clause.
 *
 * The fixture is a small in-memory project written under a temp
 * directory: a couple of source files, a tsconfig.json. We exercise
 * `discoverFiles → parseProject → walkProject → resolveCallSites`
 * twice (for determinism checks) and inspect the outputs.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { typescriptGraphAdapter } from '../lang-typescript/index.js';

import type {
  CallSiteRecord,
  WalkOutput,
} from '../lang-adapter/types.js';
import type { TypescriptParsedProject } from '../lang-typescript/parse.js';
import type { Catalog, FunctionOccurrence } from '../types.js';
import type ts from 'typescript';

const FIXTURE_TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: 'ES2022',
    module: 'Node16',
    moduleResolution: 'Node16',
    lib: ['ES2022'],
    strict: true,
    esModuleInterop: true,
    skipLibCheck: true,
    rootDir: '.',
  },
  include: ['**/*.ts'],
});

const FIXTURE_FILES: Readonly<Record<string, string>> = {
  'src/main.ts': `
    import { helper } from './util.js';
    export function entry(): number {
      const r = helper(2);
      return r * 2;
    }
    function unused(): void {
      console.log('orphan');
    }
  `,
  'src/util.ts': `
    export function helper(x: number): number {
      return x + 1;
    }
    export const arrow = (n: number) => n + 2;
  `,
};

function setupFixture(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'tsconfig.json'), FIXTURE_TSCONFIG, 'utf8');
  for (const [rel, content] of Object.entries(FIXTURE_FILES)) {
    const p = join(dir, rel);
    mkdirSync(p.slice(0, Math.max(0, p.lastIndexOf('/'))), { recursive: true });
    writeFileSync(p, content, 'utf8');
  }
}

function buildPipeline(adapter = typescriptGraphAdapter, dir: string): {
  readonly project: TypescriptParsedProject;
  readonly walk: WalkOutput;
  readonly catalog: Catalog;
  readonly discovery: ReturnType<typeof typescriptGraphAdapter.discoverFiles>;
} {
  const discovery = adapter.discoverFiles({ cwd: dir });
  const parsed = adapter.parseProject({
    projectDirAbs: discovery.projectDirAbs,
    files: discovery.files,
    compilerOptions: discovery.compilerOptions,
  });
  const walk = adapter.walkProject({
    project: parsed.project,
    projectDirAbs: discovery.projectDirAbs,
    files: discovery.files,
  });
  const catalog: Catalog = {
    version: '3.0',
    tool: 'graph',
    language: adapter.id,
    builtAt: '2026-05-18T00:00:00.000Z',
    cacheKey: adapter.cacheKey({
      projectDirAbs: discovery.projectDirAbs,
      configPathAbs: discovery.configPathAbs,
      compilerOptions: discovery.compilerOptions,
    }),
    functions: walk.occurrences,
  };
  return { project: parsed.project, walk, catalog, discovery };
}

function canonicalizeWalkOutput(walk: WalkOutput): {
  readonly occurrences: ReadonlyMap<string, number>;
  readonly callSiteSummary: readonly string[];
} {
  // Hash-only summary so we don't compare opaque AST node refs.
  const occurrences = new Map<string, number>();
  for (const arr of Object.values(walk.occurrences)) {
    for (const o of arr) {
      occurrences.set(o.bodyHash, (occurrences.get(o.bodyHash) ?? 0) + 1);
    }
  }
  const callSiteSummary = walk.callSites
    .map((r) => `${r.kind}|${r.ownerHash}|${r.childHash ?? ''}`)
    .sort();
  return { occurrences, callSiteSummary };
}

describe('GraphLanguageAdapter contract — TypeScript', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'graph-contract-'));
    setupFixture(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // ── adapter shape ────────────────────────────────────────────

  it('exposes the six required adapter methods + identity fields', () => {
    expect(typescriptGraphAdapter.id).toBe('typescript');
    expect(typescriptGraphAdapter.fileExtensions).toContain('.ts');
    expect(typescriptGraphAdapter.fileExtensions).toContain('.tsx');
    expect(typescriptGraphAdapter.displayName).toBeDefined();
    expect(typeof typescriptGraphAdapter.discoverFiles).toBe('function');
    expect(typeof typescriptGraphAdapter.parseProject).toBe('function');
    expect(typeof typescriptGraphAdapter.walkProject).toBe('function');
    expect(typeof typescriptGraphAdapter.resolveCallSites).toBe('function');
    expect(typeof typescriptGraphAdapter.cacheKey).toBe('function');
  });

  // ── I-1: walkProject is deterministic ────────────────────────

  it('I-1 — walkProject is deterministic across two runs over the same project', () => {
    const a = buildPipeline(typescriptGraphAdapter, dir);
    const b = buildPipeline(typescriptGraphAdapter, dir);
    const ca = canonicalizeWalkOutput(a.walk);
    const cb = canonicalizeWalkOutput(b.walk);
    expect(cb.occurrences).toEqual(ca.occurrences);
    expect(cb.callSiteSummary).toEqual(ca.callSiteSummary);
  });

  // ── I-2: bodyHash collisions are intentional duplicates ──────

  it('I-2 — different function bodies produce different bodyHashes', () => {
    const { walk } = buildPipeline(typescriptGraphAdapter, dir);
    const allOccs: FunctionOccurrence[] = [];
    for (const arr of Object.values(walk.occurrences)) allOccs.push(...arr);
    // Map bodyHash → count of occurrences.
    const byHash = new Map<string, number>();
    for (const o of allOccs) byHash.set(o.bodyHash, (byHash.get(o.bodyHash) ?? 0) + 1);
    // No collisions in the fixture (every helper/entry/unused/arrow has
    // a different body).
    const collisions = [...byHash.values()].filter((n) => n > 1);
    expect(collisions).toHaveLength(0);
  });

  // ── I-3: every CallSiteRecord.ownerHash exists in occurrences ──

  it('I-3 — every CallSiteRecord.ownerHash maps to a known occurrence', () => {
    const { walk } = buildPipeline(typescriptGraphAdapter, dir);
    const knownHashes = new Set<string>();
    for (const arr of Object.values(walk.occurrences)) {
      for (const o of arr) knownHashes.add(o.bodyHash);
    }
    for (const r of walk.callSites) {
      expect(knownHashes.has(r.ownerHash)).toBe(true);
    }
  });

  // ── I-4: resolveCallSites doesn't mutate catalog ─────────────

  it('I-4 — resolveCallSites does not mutate the input catalog', () => {
    const { walk, catalog, project } = buildPipeline(typescriptGraphAdapter, dir);
    const before = JSON.stringify(catalog);
    typescriptGraphAdapter.resolveCallSites({
      project,
      catalog,
      callSites: walk.callSites,
      projectDirAbs: dir,
    });
    const after = JSON.stringify(catalog);
    expect(after).toBe(before);
  });

  // ── I-5: every CallEdge.to references a catalog bodyHash or is empty ──

  it('I-5 — every CallEdge.to references a catalog bodyHash or is empty', () => {
    const { walk, catalog, project } = buildPipeline(typescriptGraphAdapter, dir);
    const knownHashes = new Set<string>();
    for (const arr of Object.values(catalog.functions)) {
      for (const o of arr) knownHashes.add(o.bodyHash);
    }
    const resolved = typescriptGraphAdapter.resolveCallSites({
      project,
      catalog,
      callSites: walk.callSites,
      projectDirAbs: dir,
    });
    for (const edges of resolved.edgesByOwner.values()) {
      for (const e of edges) {
        if (e.to.length === 0) continue; // unresolved is allowed
        for (const target of e.to) {
          expect(knownHashes.has(target)).toBe(true);
        }
      }
    }
  });

  // ── I-6: cacheKey is stable for stable input ─────────────────

  it('I-6 — cacheKey is stable for the same projectDir / configPath input', () => {
    const { discovery } = buildPipeline(typescriptGraphAdapter, dir);
    const k1 = typescriptGraphAdapter.cacheKey({
      projectDirAbs: discovery.projectDirAbs,
      configPathAbs: discovery.configPathAbs,
      compilerOptions: discovery.compilerOptions,
    });
    const k2 = typescriptGraphAdapter.cacheKey({
      projectDirAbs: discovery.projectDirAbs,
      configPathAbs: discovery.configPathAbs,
      compilerOptions: discovery.compilerOptions,
    });
    expect(k2).toBe(k1);
    // The TS adapter prefixes with its id so cross-adapter collisions
    // are impossible.
    expect(k1.startsWith('ts-')).toBe(true);
  });

  it('I-6 — cacheKey changes when the tsconfig content changes', () => {
    const { discovery } = buildPipeline(typescriptGraphAdapter, dir);
    const before = typescriptGraphAdapter.cacheKey({
      projectDirAbs: discovery.projectDirAbs,
      configPathAbs: discovery.configPathAbs,
      compilerOptions: discovery.compilerOptions,
    });
    // Mutate the tsconfig (a meaningful semantic change).
    if (discovery.configPathAbs) {
      writeFileSync(
        discovery.configPathAbs,
        JSON.stringify({
          compilerOptions: {
            target: 'ES2020',
            module: 'Node16',
            moduleResolution: 'Node16',
            strict: true,
          },
          include: ['**/*.ts'],
        }),
        'utf8',
      );
    }
    const after = typescriptGraphAdapter.cacheKey({
      projectDirAbs: discovery.projectDirAbs,
      configPathAbs: discovery.configPathAbs,
      compilerOptions: discovery.compilerOptions,
    });
    expect(after).not.toBe(before);
  });

  // ── I-7: parseProject is total over `files` ──────────────────

  it('I-7 — parseProject is total: every file is either parsed or in parseErrors', () => {
    const discovery = typescriptGraphAdapter.discoverFiles({ cwd: dir });
    const parsed = typescriptGraphAdapter.parseProject({
      projectDirAbs: discovery.projectDirAbs,
      files: discovery.files,
      compilerOptions: discovery.compilerOptions,
    });
    // For TypeScript: a clean fixture parses without errors.
    // The contract: each file either parses (i.e. is reachable from
    // the program) or is named in parseErrors.
    const tsProject = parsed.project as { program: ts.Program };
    const reachable = new Set(tsProject.program.getSourceFiles().map((sf) => sf.fileName));
    const erroredFiles = new Set(parsed.parseErrors.map((e) => e.filePath));
    for (const f of discovery.files) {
      const seen = reachable.has(f) || erroredFiles.has(f);
      // realpath quirks: try suffix match too.
      const suffixMatch = [...reachable].some((r) => r.endsWith(f.replace(discovery.projectDirAbs, '')));
      expect(seen || suffixMatch).toBe(true);
    }
  });

  // ── I-8: adapter is single-language ──────────────────────────

  it('I-8 — adapter id matches its handled language family', () => {
    expect(typescriptGraphAdapter.id).toBe('typescript');
    // The TS adapter's catalog cacheKey prefix encodes the language;
    // a Python adapter (when it lands) MUST emit a different prefix.
    const k = typescriptGraphAdapter.cacheKey({ projectDirAbs: dir });
    expect(k).toMatch(/^ts-/);
  });

  // ── I-9: adapter is referentially transparent ────────────────

  it('I-9 — repeated discoverFiles calls return the same files list', () => {
    const a = typescriptGraphAdapter.discoverFiles({ cwd: dir });
    const b = typescriptGraphAdapter.discoverFiles({ cwd: dir });
    expect(b.projectDirAbs).toBe(a.projectDirAbs);
    expect([...b.files].sort()).toEqual([...a.files].sort());
    expect(b.configPathAbs).toBe(a.configPathAbs);
  });

  // ── walkOutput shape ─────────────────────────────────────────

  it('walkProject emits the expected occurrence kinds for the fixture', () => {
    const { walk } = buildPipeline(typescriptGraphAdapter, dir);
    const kinds = new Set<string>();
    for (const arr of Object.values(walk.occurrences)) {
      for (const o of arr) kinds.add(o.kind);
    }
    expect(kinds.has('module-init')).toBe(true);
    expect(kinds.has('function-declaration')).toBe(true);
    // The arrow `arrow` from util.ts.
    expect(kinds.has('arrow')).toBe(true);
  });

  it('CallSiteRecord opaque handles round-trip through resolveCallSites', () => {
    const { walk, catalog, project } = buildPipeline(typescriptGraphAdapter, dir);
    const records: CallSiteRecord[] = [...walk.callSites];
    expect(records.length).toBeGreaterThan(0);
    // The opaque shape uses nodeRef/sourceFileRef; the adapter can
    // cast back successfully (validated by no thrown errors).
    expect(() =>
      typescriptGraphAdapter.resolveCallSites({
        project,
        catalog,
        callSites: records,
        projectDirAbs: dir,
      }),
    ).not.toThrow();
  });
});
