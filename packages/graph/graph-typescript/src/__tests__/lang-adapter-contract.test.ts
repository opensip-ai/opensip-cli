// @fitness-ignore-file file-length-limit -- Contract test suite covering the 9 behavioral invariants (I-1..I-9) for the TS/Python/Rust GraphLanguageAdapter cohort exercised here; splitting per-language fragments the single-source contract document those tests verify.
/**
 * GraphLanguageAdapter contract test suite.
 *
 * Validates each of the 9 behavioral invariants (I-1 through I-9)
 * defined in docs/plans/11-graph-language-adapter-contract.md §3
 * against the TS/Python/Rust adapters covered in this suite. Additional
 * adapter cohorts can add `describe` blocks against their own fixtures while
 * referencing the same invariants.
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

import {
  type CallSiteRecord,
  type Catalog,
  type FunctionOccurrence,
  type GraphLanguageAdapter,
  type WalkOutput,
} from '@opensip-tools/graph';
import {
  pythonGraphAdapter,
  type PythonParsedProject,
} from '@opensip-tools/graph-python';
import {
  rustGraphAdapter,
  type RustParsedProject,
} from '@opensip-tools/graph-rust';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';


import { typescriptGraphAdapter, type TsParsed } from '../index.js';

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
  readonly project: TsParsed;
  readonly walk: WalkOutput;
  readonly catalog: Catalog;
  readonly discovery: ReturnType<typeof typescriptGraphAdapter.discoverFiles>;
} {
  const discovery = adapter.discoverFiles({ cwd: dir });
  const parsed = adapter.parseProject({
    projectDirAbs: discovery.projectDirAbs,
    files: discovery.files,
    compilerOptions: discovery.compilerOptions,
    resolutionMode: 'exact',
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
      resolutionMode: 'exact',
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

  it('I-4 — resolveCallSites does not mutate the input catalog', async () => {
    const { walk, catalog, project } = buildPipeline(typescriptGraphAdapter, dir);
    const before = JSON.stringify(catalog);
    await typescriptGraphAdapter.resolveCallSites({
      project,
      catalog,
      callSites: walk.callSites,
      projectDirAbs: dir,
      resolutionMode: 'exact',
    });
    const after = JSON.stringify(catalog);
    expect(after).toBe(before);
  });

  // ── I-5: every CallEdge.to references a catalog bodyHash or is empty ──

  it('I-5 — every CallEdge.to references a catalog bodyHash or is empty', async () => {
    const { walk, catalog, project } = buildPipeline(typescriptGraphAdapter, dir);
    const knownHashes = new Set<string>();
    for (const arr of Object.values(catalog.functions)) {
      for (const o of arr) knownHashes.add(o.bodyHash);
    }
    const resolved = await typescriptGraphAdapter.resolveCallSites({
      project,
      catalog,
      callSites: walk.callSites,
      projectDirAbs: dir,
      resolutionMode: 'exact',
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
      resolutionMode: 'exact',
    });
    const k2 = typescriptGraphAdapter.cacheKey({
      projectDirAbs: discovery.projectDirAbs,
      configPathAbs: discovery.configPathAbs,
      compilerOptions: discovery.compilerOptions,
      resolutionMode: 'exact',
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
      resolutionMode: 'exact',
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
      resolutionMode: 'exact',
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
      resolutionMode: 'exact',
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
    const k = typescriptGraphAdapter.cacheKey({ projectDirAbs: dir, resolutionMode: 'exact' });
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

  it('CallSiteRecord opaque handles round-trip through resolveCallSites', async () => {
    const { walk, catalog, project } = buildPipeline(typescriptGraphAdapter, dir);
    const records: CallSiteRecord[] = [...walk.callSites];
    expect(records.length).toBeGreaterThan(0);
    // The opaque shape uses nodeRef/sourceFileRef; the adapter can
    // cast back successfully (validated by the promise resolving, not rejecting).
    await expect(
      typescriptGraphAdapter.resolveCallSites({
        project,
        catalog,
        callSites: records,
        projectDirAbs: dir,
        resolutionMode: 'exact',
      }),
    ).resolves.toBeDefined();
  });
});

// ── Python adapter ──────────────────────────────────────────────────

const PY_FIXTURE_PYPROJECT = `[project]
name = "contract-fixture"
version = "0.1.0"
requires-python = ">=3.10"
`;

const PY_FIXTURE_FILES: Readonly<Record<string, string>> = {
  'main.py': `from util import helper, Greeter


def entry(x):
    g = Greeter("hi")
    msg = g.greet(x)
    return helper(msg)


def unused():
    print("orphan")


if __name__ == "__main__":
    entry(7)
`,
  'util.py': `def helper(value):
    return f"helper:{value}"


class Greeter:
    def __init__(self, prefix):
        self.prefix = prefix

    def greet(self, who):
        return f"{self.prefix} {who}"


add_one = lambda n: n + 1
`,
  'tests/test_sample.py': `from util import helper


def test_helper_returns_prefixed_value():
    assert helper("ok") == "helper:ok"
`,
};

function setupPythonFixture(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'pyproject.toml'), PY_FIXTURE_PYPROJECT, 'utf8');
  for (const [rel, content] of Object.entries(PY_FIXTURE_FILES)) {
    const p = join(dir, rel);
    mkdirSync(p.slice(0, Math.max(0, p.lastIndexOf('/'))), { recursive: true });
    writeFileSync(p, content, 'utf8');
  }
}

function buildPythonPipeline(
  adapter: GraphLanguageAdapter<PythonParsedProject>,
  dir: string,
): {
  readonly project: PythonParsedProject;
  readonly walk: WalkOutput;
  readonly catalog: Catalog;
  readonly discovery: ReturnType<typeof adapter.discoverFiles>;
} {
  const discovery = adapter.discoverFiles({ cwd: dir });
  const parsed = adapter.parseProject({
    projectDirAbs: discovery.projectDirAbs,
    files: discovery.files,
    compilerOptions: discovery.compilerOptions,
    resolutionMode: 'exact',
  });
  const walk = adapter.walkProject({
    project: parsed.project,
    projectDirAbs: discovery.projectDirAbs,
    files: discovery.files,
  });
  const cacheKeyArgs: Parameters<typeof adapter.cacheKey>[0] = {
    projectDirAbs: discovery.projectDirAbs,
    ...(discovery.configPathAbs === undefined ? {} : { configPathAbs: discovery.configPathAbs }),
    ...(discovery.compilerOptions === undefined ? {} : { compilerOptions: discovery.compilerOptions }),
    resolutionMode: 'exact',
  };
  const catalog: Catalog = {
    version: '3.0',
    tool: 'graph',
    language: adapter.id,
    builtAt: '2026-05-18T00:00:00.000Z',
    cacheKey: adapter.cacheKey(cacheKeyArgs),
    functions: walk.occurrences,
  };
  return { project: parsed.project, walk, catalog, discovery };
}

describe('GraphLanguageAdapter contract — Python', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'graph-contract-py-'));
    setupPythonFixture(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('exposes the six required adapter methods + identity fields', () => {
    expect(pythonGraphAdapter.id).toBe('python');
    expect(pythonGraphAdapter.fileExtensions).toContain('.py');
    expect(pythonGraphAdapter.displayName).toBeDefined();
    expect(typeof pythonGraphAdapter.discoverFiles).toBe('function');
    expect(typeof pythonGraphAdapter.parseProject).toBe('function');
    expect(typeof pythonGraphAdapter.walkProject).toBe('function');
    expect(typeof pythonGraphAdapter.resolveCallSites).toBe('function');
    expect(typeof pythonGraphAdapter.cacheKey).toBe('function');
  });

  it('I-1 — walkProject is deterministic across two runs over the same project', () => {
    const a = buildPythonPipeline(pythonGraphAdapter, dir);
    const b = buildPythonPipeline(pythonGraphAdapter, dir);
    const ca = canonicalizeWalkOutput(a.walk);
    const cb = canonicalizeWalkOutput(b.walk);
    expect(cb.occurrences).toEqual(ca.occurrences);
    expect(cb.callSiteSummary).toEqual(ca.callSiteSummary);
  });

  it('I-2 — different function bodies produce different bodyHashes', () => {
    const { walk } = buildPythonPipeline(pythonGraphAdapter, dir);
    const allOccs: FunctionOccurrence[] = [];
    for (const arr of Object.values(walk.occurrences)) allOccs.push(...arr);
    const byHash = new Map<string, number>();
    for (const o of allOccs) byHash.set(o.bodyHash, (byHash.get(o.bodyHash) ?? 0) + 1);
    const collisions = [...byHash.values()].filter((n) => n > 1);
    expect(collisions).toHaveLength(0);
  });

  it('I-3 — every CallSiteRecord.ownerHash maps to a known occurrence', () => {
    const { walk } = buildPythonPipeline(pythonGraphAdapter, dir);
    const knownHashes = new Set<string>();
    for (const arr of Object.values(walk.occurrences)) {
      for (const o of arr) knownHashes.add(o.bodyHash);
    }
    for (const r of walk.callSites) {
      expect(knownHashes.has(r.ownerHash)).toBe(true);
    }
  });

  it('I-4 — resolveCallSites does not mutate the input catalog', () => {
    const { walk, catalog, project } = buildPythonPipeline(pythonGraphAdapter, dir);
    const before = JSON.stringify(catalog);
    pythonGraphAdapter.resolveCallSites({
      project,
      catalog,
      callSites: walk.callSites,
      projectDirAbs: dir,
      resolutionMode: 'exact',
    });
    const after = JSON.stringify(catalog);
    expect(after).toBe(before);
  });

  it('I-5 — every CallEdge.to references a catalog bodyHash or is empty', () => {
    const { walk, catalog, project } = buildPythonPipeline(pythonGraphAdapter, dir);
    const knownHashes = new Set<string>();
    for (const arr of Object.values(catalog.functions)) {
      for (const o of arr) knownHashes.add(o.bodyHash);
    }
    const resolved = pythonGraphAdapter.resolveCallSites({
      project,
      catalog,
      callSites: walk.callSites,
      projectDirAbs: dir,
      resolutionMode: 'exact',
    });
    for (const edges of resolved.edgesByOwner.values()) {
      for (const e of edges) {
        if (e.to.length === 0) continue;
        for (const target of e.to) {
          expect(knownHashes.has(target)).toBe(true);
        }
      }
    }
  });

  it('I-6 — cacheKey is stable for the same projectDir / configPath input', () => {
    const { discovery } = buildPythonPipeline(pythonGraphAdapter, dir);
    const k1 = pythonGraphAdapter.cacheKey({
      projectDirAbs: discovery.projectDirAbs,
      ...(discovery.configPathAbs === undefined ? {} : { configPathAbs: discovery.configPathAbs }),
      resolutionMode: 'exact',
    });
    const k2 = pythonGraphAdapter.cacheKey({
      projectDirAbs: discovery.projectDirAbs,
      ...(discovery.configPathAbs === undefined ? {} : { configPathAbs: discovery.configPathAbs }),
      resolutionMode: 'exact',
    });
    expect(k2).toBe(k1);
    expect(k1.startsWith('py-')).toBe(true);
  });

  it('I-6 — cacheKey changes when the pyproject content changes', () => {
    const { discovery } = buildPythonPipeline(pythonGraphAdapter, dir);
    const before = pythonGraphAdapter.cacheKey({
      projectDirAbs: discovery.projectDirAbs,
      ...(discovery.configPathAbs === undefined ? {} : { configPathAbs: discovery.configPathAbs }),
      resolutionMode: 'exact',
    });
    if (discovery.configPathAbs) {
      writeFileSync(
        discovery.configPathAbs,
        `[project]
name = "contract-fixture"
version = "0.2.0"
requires-python = ">=3.11"
`,
        'utf8',
      );
    }
    const after = pythonGraphAdapter.cacheKey({
      projectDirAbs: discovery.projectDirAbs,
      ...(discovery.configPathAbs === undefined ? {} : { configPathAbs: discovery.configPathAbs }),
      resolutionMode: 'exact',
    });
    expect(after).not.toBe(before);
  });

  it('I-7 — parseProject is total: every file is either parsed or in parseErrors', () => {
    const discovery = pythonGraphAdapter.discoverFiles({ cwd: dir });
    const parsed = pythonGraphAdapter.parseProject({
      projectDirAbs: discovery.projectDirAbs,
      files: discovery.files,
      resolutionMode: 'exact',
    });
    const erroredFiles = new Set(parsed.parseErrors.map((e) => e.filePath));
    for (const f of discovery.files) {
      const inProject = parsed.project.files.has(f);
      const rel = f.startsWith(discovery.projectDirAbs)
        ? f.slice(discovery.projectDirAbs.length + 1)
        : f;
      const inErrors = erroredFiles.has(rel);
      expect(inProject || inErrors).toBe(true);
    }
  });

  it('I-8 — adapter id matches its handled language family', () => {
    expect(pythonGraphAdapter.id).toBe('python');
    const k = pythonGraphAdapter.cacheKey({ projectDirAbs: dir, resolutionMode: 'exact' });
    expect(k).toMatch(/^py-/);
    // Cross-adapter prefix isolation: the TS adapter must NEVER produce
    // a key starting with `py-` and vice-versa. (I-8 backstop.)
    expect(k.startsWith('ts-')).toBe(false);
  });

  it('I-9 — repeated discoverFiles calls return the same files list', () => {
    const a = pythonGraphAdapter.discoverFiles({ cwd: dir });
    const b = pythonGraphAdapter.discoverFiles({ cwd: dir });
    expect(b.projectDirAbs).toBe(a.projectDirAbs);
    expect([...b.files].sort()).toEqual([...a.files].sort());
    expect(b.configPathAbs).toBe(a.configPathAbs);
  });

  it('walkProject emits the expected occurrence kinds for the fixture', () => {
    const { walk } = buildPythonPipeline(pythonGraphAdapter, dir);
    const kinds = new Set<string>();
    for (const arr of Object.values(walk.occurrences)) {
      for (const o of arr) kinds.add(o.kind);
    }
    expect(kinds.has('module-init')).toBe(true);
    expect(kinds.has('function-declaration')).toBe(true);
    expect(kinds.has('method')).toBe(true);
    expect(kinds.has('constructor')).toBe(true);
    expect(kinds.has('arrow')).toBe(true);
  });

  it('resolveCallSites produces non-empty edges for the fixture', () => {
    const { walk, catalog, project } = buildPythonPipeline(pythonGraphAdapter, dir);
    expect(walk.callSites.length).toBeGreaterThan(0);
    const resolved = pythonGraphAdapter.resolveCallSites({
      project,
      catalog,
      callSites: walk.callSites,
      projectDirAbs: dir,
      resolutionMode: 'exact',
    });
    let resolvedEdges = 0;
    for (const edges of resolved.edgesByOwner.values()) {
      for (const e of edges) {
        if (e.to.length > 0) resolvedEdges++;
      }
    }
    expect(resolvedEdges).toBeGreaterThan(0);
    // The Python adapter's name-based resolution produces medium/low —
    // never high — for ordinary call edges. Creation edges (lambda) are
    // the only `'high'` source.
    const allConfidences = new Set<string>();
    for (const edges of resolved.edgesByOwner.values()) {
      for (const e of edges) allConfidences.add(e.confidence);
    }
    expect(allConfidences.has('high') || allConfidences.has('medium')).toBe(true);
  });
});

// ── Rust adapter ────────────────────────────────────────────────────

const RS_FIXTURE_CARGO_TOML = `[package]
name = "contract-fixture"
version = "0.1.0"
edition = "2021"
`;

const RS_FIXTURE_FILES: Readonly<Record<string, string>> = {
  'src/main.rs': `mod util;

use util::{Greeter, helper};

fn entry(x: i32) -> String {
    let g = Greeter::new("hello");
    let msg = g.greet(x);
    helper(&msg)
}

fn unused() {
    println!("orphan");
}

fn main() {
    let result = entry(7);
    println!("{}", result);
}
`,
  'src/util.rs': `pub fn helper(value: &str) -> String {
    format!("helper:{}", value)
}

pub struct Greeter {
    prefix: String,
}

impl Greeter {
    pub fn new(prefix: &str) -> Self {
        Greeter { prefix: prefix.to_string() }
    }

    pub fn greet(&self, who: i32) -> String {
        format!("{} {}", self.prefix, who)
    }
}

pub fn make_adder() -> impl Fn(i32) -> i32 {
    let inc = |n: i32| n + 1;
    inc
}
`,
  'tests/integration_test.rs': `#[test]
fn helper_prepends_prefix() {
    assert_eq!(1 + 1, 2);
}
`,
};

function setupRustFixture(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'Cargo.toml'), RS_FIXTURE_CARGO_TOML, 'utf8');
  for (const [rel, content] of Object.entries(RS_FIXTURE_FILES)) {
    const p = join(dir, rel);
    mkdirSync(p.slice(0, Math.max(0, p.lastIndexOf('/'))), { recursive: true });
    writeFileSync(p, content, 'utf8');
  }
}

function buildRustPipeline(
  adapter: GraphLanguageAdapter<RustParsedProject>,
  dir: string,
): {
  readonly project: RustParsedProject;
  readonly walk: WalkOutput;
  readonly catalog: Catalog;
  readonly discovery: ReturnType<typeof adapter.discoverFiles>;
} {
  const discovery = adapter.discoverFiles({ cwd: dir });
  const parsed = adapter.parseProject({
    projectDirAbs: discovery.projectDirAbs,
    files: discovery.files,
    compilerOptions: discovery.compilerOptions,
    resolutionMode: 'exact',
  });
  const walk = adapter.walkProject({
    project: parsed.project,
    projectDirAbs: discovery.projectDirAbs,
    files: discovery.files,
  });
  const cacheKeyArgs: Parameters<typeof adapter.cacheKey>[0] = {
    projectDirAbs: discovery.projectDirAbs,
    ...(discovery.configPathAbs === undefined ? {} : { configPathAbs: discovery.configPathAbs }),
    resolutionMode: 'exact',
  };
  const catalog: Catalog = {
    version: '3.0',
    tool: 'graph',
    language: adapter.id,
    builtAt: '2026-05-18T00:00:00.000Z',
    cacheKey: adapter.cacheKey(cacheKeyArgs),
    functions: walk.occurrences,
  };
  return { project: parsed.project, walk, catalog, discovery };
}

describe('GraphLanguageAdapter contract — Rust', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'graph-contract-rs-'));
    setupRustFixture(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('exposes the six required adapter methods + identity fields', () => {
    expect(rustGraphAdapter.id).toBe('rust');
    expect(rustGraphAdapter.fileExtensions).toContain('.rs');
    expect(rustGraphAdapter.displayName).toBeDefined();
    expect(typeof rustGraphAdapter.discoverFiles).toBe('function');
    expect(typeof rustGraphAdapter.parseProject).toBe('function');
    expect(typeof rustGraphAdapter.walkProject).toBe('function');
    expect(typeof rustGraphAdapter.resolveCallSites).toBe('function');
    expect(typeof rustGraphAdapter.cacheKey).toBe('function');
  });

  it('I-1 — walkProject is deterministic across two runs over the same project', () => {
    const a = buildRustPipeline(rustGraphAdapter, dir);
    const b = buildRustPipeline(rustGraphAdapter, dir);
    const ca = canonicalizeWalkOutput(a.walk);
    const cb = canonicalizeWalkOutput(b.walk);
    expect(cb.occurrences).toEqual(ca.occurrences);
    expect(cb.callSiteSummary).toEqual(ca.callSiteSummary);
  });

  it('I-2 — different function bodies produce different bodyHashes', () => {
    const { walk } = buildRustPipeline(rustGraphAdapter, dir);
    const allOccs: FunctionOccurrence[] = [];
    for (const arr of Object.values(walk.occurrences)) allOccs.push(...arr);
    const byHash = new Map<string, number>();
    for (const o of allOccs) byHash.set(o.bodyHash, (byHash.get(o.bodyHash) ?? 0) + 1);
    const collisions = [...byHash.values()].filter((n) => n > 1);
    expect(collisions).toHaveLength(0);
  });

  it('I-3 — every CallSiteRecord.ownerHash maps to a known occurrence', () => {
    const { walk } = buildRustPipeline(rustGraphAdapter, dir);
    const knownHashes = new Set<string>();
    for (const arr of Object.values(walk.occurrences)) {
      for (const o of arr) knownHashes.add(o.bodyHash);
    }
    for (const r of walk.callSites) {
      expect(knownHashes.has(r.ownerHash)).toBe(true);
    }
  });

  it('I-4 — resolveCallSites does not mutate the input catalog', () => {
    const { walk, catalog, project } = buildRustPipeline(rustGraphAdapter, dir);
    const before = JSON.stringify(catalog);
    rustGraphAdapter.resolveCallSites({
      project,
      catalog,
      callSites: walk.callSites,
      projectDirAbs: dir,
      resolutionMode: 'exact',
    });
    const after = JSON.stringify(catalog);
    expect(after).toBe(before);
  });

  it('I-5 — every CallEdge.to references a catalog bodyHash or is empty', () => {
    const { walk, catalog, project } = buildRustPipeline(rustGraphAdapter, dir);
    const knownHashes = new Set<string>();
    for (const arr of Object.values(catalog.functions)) {
      for (const o of arr) knownHashes.add(o.bodyHash);
    }
    const resolved = rustGraphAdapter.resolveCallSites({
      project,
      catalog,
      callSites: walk.callSites,
      projectDirAbs: dir,
      resolutionMode: 'exact',
    });
    for (const edges of resolved.edgesByOwner.values()) {
      for (const e of edges) {
        if (e.to.length === 0) continue;
        for (const target of e.to) {
          expect(knownHashes.has(target)).toBe(true);
        }
      }
    }
  });

  it('I-6 — cacheKey is stable for the same projectDir / configPath input', () => {
    const { discovery } = buildRustPipeline(rustGraphAdapter, dir);
    const k1 = rustGraphAdapter.cacheKey({
      projectDirAbs: discovery.projectDirAbs,
      ...(discovery.configPathAbs === undefined ? {} : { configPathAbs: discovery.configPathAbs }),
      resolutionMode: 'exact',
    });
    const k2 = rustGraphAdapter.cacheKey({
      projectDirAbs: discovery.projectDirAbs,
      ...(discovery.configPathAbs === undefined ? {} : { configPathAbs: discovery.configPathAbs }),
      resolutionMode: 'exact',
    });
    expect(k2).toBe(k1);
    expect(k1.startsWith('rs-')).toBe(true);
  });

  it('I-6 — cacheKey changes when the Cargo manifest content changes', () => {
    const { discovery } = buildRustPipeline(rustGraphAdapter, dir);
    const before = rustGraphAdapter.cacheKey({
      projectDirAbs: discovery.projectDirAbs,
      ...(discovery.configPathAbs === undefined ? {} : { configPathAbs: discovery.configPathAbs }),
      resolutionMode: 'exact',
    });
    if (discovery.configPathAbs) {
      writeFileSync(
        discovery.configPathAbs,
        `[package]
name = "contract-fixture"
version = "0.2.0"
edition = "2021"
`,
        'utf8',
      );
    }
    const after = rustGraphAdapter.cacheKey({
      projectDirAbs: discovery.projectDirAbs,
      ...(discovery.configPathAbs === undefined ? {} : { configPathAbs: discovery.configPathAbs }),
      resolutionMode: 'exact',
    });
    expect(after).not.toBe(before);
  });

  it('I-7 — parseProject is total: every file is either parsed or in parseErrors', () => {
    const discovery = rustGraphAdapter.discoverFiles({ cwd: dir });
    const parsed = rustGraphAdapter.parseProject({
      projectDirAbs: discovery.projectDirAbs,
      files: discovery.files,
      resolutionMode: 'exact',
    });
    const erroredFiles = new Set(parsed.parseErrors.map((e) => e.filePath));
    for (const f of discovery.files) {
      const inProject = parsed.project.files.has(f);
      const rel = f.startsWith(discovery.projectDirAbs)
        ? f.slice(discovery.projectDirAbs.length + 1)
        : f;
      const inErrors = erroredFiles.has(rel);
      expect(inProject || inErrors).toBe(true);
    }
  });

  it('I-8 — adapter id matches its handled language family', () => {
    expect(rustGraphAdapter.id).toBe('rust');
    const k = rustGraphAdapter.cacheKey({ projectDirAbs: dir, resolutionMode: 'exact' });
    expect(k).toMatch(/^rs-/);
    // Cross-adapter prefix isolation. (I-8 backstop.)
    expect(k.startsWith('ts-')).toBe(false);
    expect(k.startsWith('py-')).toBe(false);
  });

  it('I-9 — repeated discoverFiles calls return the same files list', () => {
    const a = rustGraphAdapter.discoverFiles({ cwd: dir });
    const b = rustGraphAdapter.discoverFiles({ cwd: dir });
    expect(b.projectDirAbs).toBe(a.projectDirAbs);
    expect([...b.files].sort()).toEqual([...a.files].sort());
    expect(b.configPathAbs).toBe(a.configPathAbs);
  });

  it('walkProject emits the expected occurrence kinds for the fixture', () => {
    const { walk } = buildRustPipeline(rustGraphAdapter, dir);
    const kinds = new Set<string>();
    const enclosingClasses = new Set<string | null>();
    for (const arr of Object.values(walk.occurrences)) {
      for (const o of arr) {
        kinds.add(o.kind);
        enclosingClasses.add(o.enclosingClass);
      }
    }
    expect(kinds.has('module-init')).toBe(true);
    expect(kinds.has('function-declaration')).toBe(true);
    expect(kinds.has('method')).toBe(true);
    expect(kinds.has('arrow')).toBe(true);
    // The Greeter impl propagates an enclosingClass for the methods.
    expect(enclosingClasses.has('Greeter')).toBe(true);
  });

  it('resolveCallSites produces non-empty edges for the fixture', () => {
    const { walk, catalog, project } = buildRustPipeline(rustGraphAdapter, dir);
    expect(walk.callSites.length).toBeGreaterThan(0);
    const resolved = rustGraphAdapter.resolveCallSites({
      project,
      catalog,
      callSites: walk.callSites,
      projectDirAbs: dir,
      resolutionMode: 'exact',
    });
    let resolvedEdges = 0;
    for (const edges of resolved.edgesByOwner.values()) {
      for (const e of edges) {
        if (e.to.length > 0) resolvedEdges++;
      }
    }
    expect(resolvedEdges).toBeGreaterThan(0);
  });
});
