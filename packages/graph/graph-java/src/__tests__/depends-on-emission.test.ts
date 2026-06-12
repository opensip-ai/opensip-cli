/**
 * Tests for the Java adapter's module-level depends_on edge emission.
 * Phase 4 Task 4.6 of opensip's substrate consolidation (opensip DEC-498).
 *
 * Exercises the full adapter contract surface (discoverFiles →
 * parseProject → walkProject → resolveCallSites) against small fixtures
 * covering the Java `import`-declaration matrix: type imports, wildcard
 * imports, static type imports, static wildcard imports, inner-class
 * fallback, stdlib + Jakarta paths, external third-party paths, and
 * Maven (`src/main/java/`) vs plain (project-root) source layouts.
 *
 * Mirrors the Rust adapter's Task 4.5 test layout.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { javaGraphAdapter } from '../index.js';

import type { Catalog, FunctionOccurrence } from '@opensip-cli/graph';

let fixtureRoot: string;

beforeEach(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'graph-java-depends-on-'));
});

afterEach(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

function writeFile(rel: string, content: string): void {
  const abs = join(fixtureRoot, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content, 'utf8');
}

function findModuleInit(catalog: Catalog, filePath: string): FunctionOccurrence | undefined {
  for (const occs of Object.values(catalog.functions)) {
    for (const o of occs) {
      if (o.kind === 'module-init' && o.filePath === filePath) return o;
    }
  }
  return undefined;
}

function runAdapter(): {
  catalog: Catalog;
  dependenciesByOwner:
    | ReadonlyMap<
        string,
        readonly {
          readonly to: readonly string[];
          readonly specifier: string;
          readonly line: number;
          readonly column: number;
        }[]
      >
    | undefined;
} {
  const discovery = javaGraphAdapter.discoverFiles({ cwd: fixtureRoot });
  const parsed = javaGraphAdapter.parseProject({
    projectDirAbs: discovery.projectDirAbs,
    files: discovery.files,
    compilerOptions: discovery.compilerOptions,
    resolutionMode: 'exact',
  });
  const walked = javaGraphAdapter.walkProject({
    project: parsed.project,
    projectDirAbs: discovery.projectDirAbs,
    files: discovery.files,
  });
  const initialCatalog: Catalog = {
    version: '3.0',
    tool: 'graph',
    language: 'java',
    builtAt: new Date().toISOString(),
    cacheKey: 'test',
    functions: walked.occurrences,
  };
  const resolved = javaGraphAdapter.resolveCallSites({
    project: parsed.project,
    catalog: initialCatalog,
    callSites: walked.callSites,
    dependencySites: walked.dependencySites,
    projectDirAbs: discovery.projectDirAbs,
    resolutionMode: 'exact',
  });
  return { catalog: initialCatalog, dependenciesByOwner: resolved.dependenciesByOwner };
}

describe('Java adapter — depends_on emission (Phase 4)', () => {
  it('resolves a plain type import to the target module-init (plain layout)', () => {
    writeFile(
      'com/example/Main.java',
      `package com.example;\n\nimport com.example.foo.Bar;\n\nclass Main { void run(Bar b) {} }\n`,
    );
    writeFile('com/example/foo/Bar.java', `package com.example.foo;\n\npublic class Bar {}\n`);

    const { catalog, dependenciesByOwner } = runAdapter();
    const mainInit = findModuleInit(catalog, 'com/example/Main.java');
    const barInit = findModuleInit(catalog, 'com/example/foo/Bar.java');

    expect(mainInit, 'main module-init').toBeDefined();
    expect(barInit, 'bar module-init').toBeDefined();
    expect(dependenciesByOwner, 'dependenciesByOwner').toBeDefined();

    const deps = dependenciesByOwner!.get(mainInit!.bodyHash);
    expect(deps, 'main has dependency edges').toHaveLength(1);
    expect(deps![0].specifier).toBe('com.example.foo.Bar');
    expect(deps![0].to).toEqual([barInit!.bodyHash]);
  });

  it('resolves a wildcard import to every module-init in the package (polymorphic)', () => {
    writeFile(
      'com/example/Main.java',
      `package com.example;\n\nimport com.example.foo.*;\n\nclass Main {}\n`,
    );
    writeFile('com/example/foo/A.java', `package com.example.foo;\n\npublic class A {}\n`);
    writeFile('com/example/foo/B.java', `package com.example.foo;\n\npublic class B {}\n`);

    const { catalog, dependenciesByOwner } = runAdapter();
    const mainInit = findModuleInit(catalog, 'com/example/Main.java');
    const aInit = findModuleInit(catalog, 'com/example/foo/A.java');
    const bInit = findModuleInit(catalog, 'com/example/foo/B.java');

    expect(mainInit).toBeDefined();
    expect(aInit).toBeDefined();
    expect(bInit).toBeDefined();

    const deps = dependenciesByOwner!.get(mainInit!.bodyHash);
    expect(deps).toHaveLength(1);
    expect(deps![0].specifier).toBe('com.example.foo.*');
    expect([...deps![0].to].sort()).toEqual([aInit!.bodyHash, bInit!.bodyHash].sort());
  });

  it('resolves an inner-class import via fall-back to the outer class', () => {
    // `Outer.Inner` is not in the catalog as a file; we fall back to
    // `Outer` (which IS a file).
    writeFile(
      'com/example/Main.java',
      `package com.example;\n\nimport com.example.foo.Outer.Inner;\n\nclass Main {}\n`,
    );
    writeFile(
      'com/example/foo/Outer.java',
      `package com.example.foo;\n\npublic class Outer { public static class Inner {} }\n`,
    );

    const { catalog, dependenciesByOwner } = runAdapter();
    const mainInit = findModuleInit(catalog, 'com/example/Main.java');
    const outerInit = findModuleInit(catalog, 'com/example/foo/Outer.java');

    expect(mainInit).toBeDefined();
    expect(outerInit).toBeDefined();

    const deps = dependenciesByOwner!.get(mainInit!.bodyHash);
    expect(deps).toHaveLength(1);
    expect(deps![0].specifier).toBe('com.example.foo.Outer.Inner');
    expect(deps![0].to).toEqual([outerInit!.bodyHash]);
  });

  it('resolves a static type import to the owning class module-init', () => {
    writeFile(
      'com/example/Main.java',
      `package com.example;\n\nimport static com.example.foo.Bar.someMethod;\n\nclass Main {}\n`,
    );
    writeFile(
      'com/example/foo/Bar.java',
      `package com.example.foo;\n\npublic class Bar { public static void someMethod() {} }\n`,
    );

    const { catalog, dependenciesByOwner } = runAdapter();
    const mainInit = findModuleInit(catalog, 'com/example/Main.java');
    const barInit = findModuleInit(catalog, 'com/example/foo/Bar.java');

    expect(mainInit).toBeDefined();
    expect(barInit).toBeDefined();

    const deps = dependenciesByOwner!.get(mainInit!.bodyHash);
    expect(deps).toHaveLength(1);
    expect(deps![0].specifier).toBe('static com.example.foo.Bar.someMethod');
    expect(deps![0].to).toEqual([barInit!.bodyHash]);
  });

  it('resolves a static wildcard import to the owning class module-init', () => {
    writeFile(
      'com/example/Main.java',
      `package com.example;\n\nimport static com.example.foo.Bar.*;\n\nclass Main {}\n`,
    );
    writeFile(
      'com/example/foo/Bar.java',
      `package com.example.foo;\n\npublic class Bar { public static void a() {} public static int b = 1; }\n`,
    );

    const { catalog, dependenciesByOwner } = runAdapter();
    const mainInit = findModuleInit(catalog, 'com/example/Main.java');
    const barInit = findModuleInit(catalog, 'com/example/foo/Bar.java');

    expect(mainInit).toBeDefined();
    expect(barInit).toBeDefined();

    const deps = dependenciesByOwner!.get(mainInit!.bodyHash);
    expect(deps).toHaveLength(1);
    expect(deps![0].specifier).toBe('static com.example.foo.Bar.*');
    expect(deps![0].to).toEqual([barInit!.bodyHash]);
  });

  it('emits unresolved edges for stdlib (`java.*`) imports', () => {
    writeFile(
      'com/example/Main.java',
      `package com.example;\n\nimport java.util.List;\n\nclass Main {}\n`,
    );

    const { catalog, dependenciesByOwner } = runAdapter();
    const mainInit = findModuleInit(catalog, 'com/example/Main.java');
    expect(mainInit).toBeDefined();

    const deps = dependenciesByOwner!.get(mainInit!.bodyHash);
    expect(deps).toHaveLength(1);
    expect(deps![0].specifier).toBe('java.util.List');
    expect(deps![0].to).toEqual([]);
  });

  it('emits unresolved edges for `javax.*` / `jakarta.*` imports', () => {
    writeFile(
      'com/example/Main.java',
      `package com.example;\n\nimport javax.servlet.HttpServletRequest;\nimport jakarta.inject.Inject;\n\nclass Main {}\n`,
    );

    const { catalog, dependenciesByOwner } = runAdapter();
    const mainInit = findModuleInit(catalog, 'com/example/Main.java');
    expect(mainInit).toBeDefined();

    const deps = dependenciesByOwner!.get(mainInit!.bodyHash);
    expect(deps).toHaveLength(2);
    const specifiers = deps!.map((d) => d.specifier).sort();
    expect(specifiers).toEqual(['jakarta.inject.Inject', 'javax.servlet.HttpServletRequest']);
    for (const d of deps!) {
      expect(d.to).toEqual([]);
    }
  });

  it('emits unresolved edges for external third-party imports', () => {
    writeFile(
      'com/example/Main.java',
      `package com.example;\n\nimport com.google.gson.Gson;\n\nclass Main {}\n`,
    );

    const { catalog, dependenciesByOwner } = runAdapter();
    const mainInit = findModuleInit(catalog, 'com/example/Main.java');
    expect(mainInit).toBeDefined();

    const deps = dependenciesByOwner!.get(mainInit!.bodyHash);
    expect(deps).toHaveLength(1);
    expect(deps![0].specifier).toBe('com.google.gson.Gson');
    expect(deps![0].to).toEqual([]);
  });

  it('emits one dep site per import statement when a file has many imports', () => {
    writeFile(
      'com/example/Main.java',
      `package com.example;\n\nimport com.example.foo.Bar;\nimport java.util.List;\nimport com.example.foo.Baz;\n\nclass Main {}\n`,
    );
    writeFile('com/example/foo/Bar.java', `package com.example.foo;\n\npublic class Bar {}\n`);
    writeFile('com/example/foo/Baz.java', `package com.example.foo;\n\npublic class Baz {}\n`);

    const { catalog, dependenciesByOwner } = runAdapter();
    const mainInit = findModuleInit(catalog, 'com/example/Main.java');
    const barInit = findModuleInit(catalog, 'com/example/foo/Bar.java');
    const bazInit = findModuleInit(catalog, 'com/example/foo/Baz.java');

    expect(mainInit).toBeDefined();
    expect(barInit).toBeDefined();
    expect(bazInit).toBeDefined();

    const deps = dependenciesByOwner!.get(mainInit!.bodyHash);
    expect(deps).toHaveLength(3);
    const bySpec = new Map(deps!.map((d) => [d.specifier, d]));
    expect(bySpec.get('com.example.foo.Bar')!.to).toEqual([barInit!.bodyHash]);
    expect(bySpec.get('java.util.List')!.to).toEqual([]);
    expect(bySpec.get('com.example.foo.Baz')!.to).toEqual([bazInit!.bodyHash]);
  });

  it('produces no dependency edges for a file with no explicit imports', () => {
    writeFile(
      'com/example/Main.java',
      `package com.example;\n\nclass Main { int answer() { return 42; } }\n`,
    );

    const { catalog, dependenciesByOwner } = runAdapter();
    const mainInit = findModuleInit(catalog, 'com/example/Main.java');
    expect(mainInit).toBeDefined();

    const deps = dependenciesByOwner?.get(mainInit!.bodyHash);
    expect(deps).toBeUndefined();
  });

  it('resolves imports under the Maven `src/main/java/` source root', () => {
    writeFile(
      'src/main/java/com/example/Main.java',
      `package com.example;\n\nimport com.example.foo.Bar;\n\nclass Main { void run(Bar b) {} }\n`,
    );
    writeFile(
      'src/main/java/com/example/foo/Bar.java',
      `package com.example.foo;\n\npublic class Bar {}\n`,
    );

    const { catalog, dependenciesByOwner } = runAdapter();
    const mainInit = findModuleInit(catalog, 'src/main/java/com/example/Main.java');
    const barInit = findModuleInit(catalog, 'src/main/java/com/example/foo/Bar.java');

    expect(mainInit, 'main module-init').toBeDefined();
    expect(barInit, 'bar module-init').toBeDefined();

    const deps = dependenciesByOwner!.get(mainInit!.bodyHash);
    expect(deps).toHaveLength(1);
    expect(deps![0].specifier).toBe('com.example.foo.Bar');
    expect(deps![0].to).toEqual([barInit!.bodyHash]);
  });

  it('resolves imports under the plain `src/` source root', () => {
    writeFile(
      'src/com/example/Main.java',
      `package com.example;\n\nimport com.example.foo.Bar;\n\nclass Main {}\n`,
    );
    writeFile('src/com/example/foo/Bar.java', `package com.example.foo;\n\npublic class Bar {}\n`);

    const { catalog, dependenciesByOwner } = runAdapter();
    const mainInit = findModuleInit(catalog, 'src/com/example/Main.java');
    const barInit = findModuleInit(catalog, 'src/com/example/foo/Bar.java');

    expect(mainInit).toBeDefined();
    expect(barInit).toBeDefined();

    const deps = dependenciesByOwner!.get(mainInit!.bodyHash);
    expect(deps).toHaveLength(1);
    expect(deps![0].specifier).toBe('com.example.foo.Bar');
    expect(deps![0].to).toEqual([barInit!.bodyHash]);
  });
});
