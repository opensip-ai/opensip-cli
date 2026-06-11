/**
 * Second round of targeted branch-coverage tests for graph-go.
 *
 * These hit branch directions not exercised by the existing suites:
 *   - walk-metadata.ts collectParamEntries — a `(comment)` named child
 *     inside a function's parameter_list (the `!== parameter_declaration
 *     && !== variadic_parameter_declaration` continue branch).
 *   - walk-metadata.ts extractReceiverType — a `(comment)` named child
 *     inside a method's receiver parameter_list (the `!==
 *     parameter_declaration` continue branch).
 *   - walk.ts pushImportSpec / unquoteGoStringLiteral — an import whose
 *     `path` is a raw_string_literal (backtick) rather than an
 *     interpreted string: `unquoteGoStringLiteral` returns null, so the
 *     `specifier === null` early-return branch fires and no dependency
 *     site is emitted for it.
 *   - resolve.ts resolveCallSites — a 'creation' CallSiteRecord whose
 *     `childHash` is undefined: the `r.childHash === undefined` guard
 *     `continue`s before emitting a creation edge.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { goGraphAdapter } from '../index.js';

import type { GoParsedProject } from '../parse.js';
import type {
  CallSiteRecord,
  Catalog,
  DependencySiteRecord,
  FunctionOccurrence,
} from '@opensip-tools/graph';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'graph-go-branch-cov2-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function discoverAndParse(): {
  readonly projectDirAbs: string;
  readonly files: readonly string[];
  readonly project: GoParsedProject;
} {
  const discovery = goGraphAdapter.discoverFiles({ cwd: dir });
  const parsed = goGraphAdapter.parseProject({
    projectDirAbs: discovery.projectDirAbs,
    files: discovery.files,
    compilerOptions: discovery.compilerOptions,
    resolutionMode: 'exact',
  });
  return {
    projectDirAbs: discovery.projectDirAbs,
    files: discovery.files,
    project: parsed.project,
  };
}

function walk(): ReturnType<typeof goGraphAdapter.walkProject> {
  const { projectDirAbs, files, project } = discoverAndParse();
  return goGraphAdapter.walkProject({ project, projectDirAbs, files });
}

describe('graph-go branch coverage (round 2)', () => {
  it('skips a leading comment node inside a function parameter list', () => {
    // The `(comment)` is a named child of the parameter_list, so
    // collectParamEntries iterates it and must skip it (it is neither a
    // parameter_declaration nor a variadic_parameter_declaration) before
    // reaching the real `a int` declaration.
    writeFileSync(
      join(dir, 'main.go'),
      `package main\nfunc f(/* leading */ a int, b string) {}\n`,
      'utf8',
    );
    const out = walk();
    const params = out.occurrences.f?.[0]?.params;
    expect(params?.map((p) => p.name)).toEqual(['a', 'b']);
  });

  it('skips a leading comment node inside a method receiver list', () => {
    // The `(comment)` precedes the parameter_declaration in the receiver
    // parameter_list, exercising extractReceiverType's skip branch.
    writeFileSync(
      join(dir, 'main.go'),
      `package main\ntype Foo struct{}\nfunc (/* recv */ f Foo) bar() int { return 1 }\n`,
      'utf8',
    );
    const out = walk();
    const bar = out.occurrences.bar?.[0];
    expect(bar?.kind).toBe('method');
    expect(bar?.enclosingClass).toBe('Foo');
  });

  it('ignores an import whose path is a raw string literal (backtick)', () => {
    // A backtick-quoted import path is not a valid interpreted string,
    // so unquoteGoStringLiteral returns null and pushImportSpec bails out
    // via the `specifier === null` branch — no dependency site emitted.
    writeFileSync(join(dir, 'main.go'), 'package main\nimport `fmt`\nfunc main() {}\n', 'utf8');
    const out = walk();
    // The malformed raw-string import yields zero dependency sites.
    expect(out.dependencySites).toEqual([]);
    // The walker still produces the module-init for the file.
    const moduleInits = Object.keys(out.occurrences).filter((n) => n.startsWith('<module-init:'));
    expect(moduleInits.length).toBe(1);
  });

  it('skips a creation call-site record whose childHash is undefined', () => {
    // The walker never emits a creation record without a childHash, but
    // resolveCallSites defends against it: the `childHash === undefined`
    // guard `continue`s before pushing a creation edge. Drive that guard
    // by feeding a synthetic creation record.
    writeFileSync(
      join(dir, 'main.go'),
      `package main\nfunc maker() func() {\n  inc := func() {}\n  return inc\n}\n`,
      'utf8',
    );
    const { projectDirAbs, files, project } = discoverAndParse();
    const walked = goGraphAdapter.walkProject({ project, projectDirAbs, files });

    // Find a real creation record produced by the walker so we have a
    // valid nodeRef/sourceFileRef, then strip its childHash.
    const realCreation = walked.callSites.find((c) => c.kind === 'creation');
    expect(realCreation).toBeDefined();
    const danglingCreation: CallSiteRecord = {
      nodeRef: realCreation!.nodeRef,
      sourceFileRef: realCreation!.sourceFileRef,
      ownerHash: realCreation!.ownerHash,
      kind: 'creation',
      // childHash deliberately omitted (undefined).
    };

    const catalog = {
      version: '3.0' as const,
      tool: 'graph' as const,
      language: 'go',
      builtAt: '2026-05-27T00:00:00.000Z',
      cacheKey: 'test',
      functions: walked.occurrences,
    };
    const resolved = goGraphAdapter.resolveCallSites({
      project,
      catalog,
      callSites: [danglingCreation],
      projectDirAbs,
      resolutionMode: 'exact',
    });

    // The dangling creation record contributes no edges and no stats.
    let edgeCount = 0;
    for (const edges of resolved.edgesByOwner.values()) edgeCount += edges.length;
    expect(edgeCount).toBe(0);
    expect(resolved.stats.totalCallSites).toBe(0);
  });

  it('tolerates an undefined catalog bucket and a non-.go module-init filePath during dependency resolution', () => {
    // resolveDependencies defends against two shapes a well-formed walker
    // never produces but the contract permits:
    //   - an `undefined` value in catalog.functions (the `!occs` continue
    //     in the module-init index build), and
    //   - a module-init occurrence whose filePath does not end in `.go`
    //     (the `!filePath.endsWith('.go')` continue in
    //     collectGoPackageMembers).
    // Drive both by handing resolveCallSites a synthetic catalog and a
    // synthetic dependency site whose specifier equals the module path.
    writeFileSync(join(dir, 'go.mod'), `module github.com/example/proj\n`, 'utf8');
    writeFileSync(
      join(dir, 'main.go'),
      `package main\nimport "github.com/example/proj"\nfunc main() {}\n`,
      'utf8',
    );
    const { projectDirAbs, files, project } = discoverAndParse();
    const walked = goGraphAdapter.walkProject({ project, projectDirAbs, files });

    const realModuleInit = Object.values(walked.occurrences)
      .flat()
      .find((o) => o.kind === 'module-init');
    expect(realModuleInit).toBeDefined();

    // A second module-init occurrence whose filePath is NOT a .go file —
    // it must be skipped when enumerating package members.
    const nonGoModuleInit: FunctionOccurrence = {
      ...realModuleInit!,
      filePath: 'README',
      bodyHash: 'non-go-hash',
    };

    const syntheticFunctions: Record<string, FunctionOccurrence[]> = {
      [realModuleInit!.simpleName]: [realModuleInit!],
      '<module-init:README>': [nonGoModuleInit],
      // An undefined bucket — `Object.values` yields it, exercising the
      // `!occs` skip in the module-init index build.
      '<empty>': undefined as unknown as FunctionOccurrence[],
    };

    const catalog: Catalog = {
      version: '3.0',
      tool: 'graph',
      language: 'go',
      builtAt: '2026-05-27T00:00:00.000Z',
      cacheKey: 'test',
      functions: syntheticFunctions,
    };

    const depSite: DependencySiteRecord = {
      nodeRef: null,
      sourceFileRef: null,
      ownerHash: realModuleInit!.bodyHash,
      specifier: 'github.com/example/proj',
      line: 2,
      column: 0,
    };

    const resolved = goGraphAdapter.resolveCallSites({
      project,
      catalog,
      callSites: [],
      dependencySites: [depSite],
      projectDirAbs,
      resolutionMode: 'exact',
    });

    const deps = resolved.dependenciesByOwner?.get(realModuleInit!.bodyHash);
    expect(deps).toHaveLength(1);
    // The bare-module import resolves to the package members at the
    // project root — only the real .go module-init, never the README one.
    expect(deps![0].to).toEqual([realModuleInit!.bodyHash]);
    expect(deps![0].to).not.toContain('non-go-hash');
  });
});
