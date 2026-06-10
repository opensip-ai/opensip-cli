/**
 * Regression: call edges must not be unioned across body-twins.
 *
 * Two files define a `work()` with an IDENTICAL body (same bodyHash) that each
 * calls a local `helper()` with a DIFFERENT body (distinct hashes). Edges are
 * bucketed per owner occurrence (bodyHash + filePath), so each `work` keeps an
 * edge to its OWN file's helper — not the union of both. Before the per-occurrence
 * keying this produced phantom cross-file edges (the `stripStrings`/`scan`
 * artifact across the language adapters).
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ownerEdgeKey } from '@opensip-tools/graph';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { typescriptGraphAdapter } from '../index.js';

import type { Catalog, FunctionOccurrence } from '@opensip-tools/graph';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'graph-ts-body-twin-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(
    join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'Node16',
        moduleResolution: 'Node16',
        strict: true,
      },
      include: ['**/*.ts'],
    }),
    'utf8',
  );
  // `work` bodies are identical (body-twin); `helper` bodies differ per file.
  writeFileSync(
    join(root, 'src/a.ts'),
    'function helper(): number { return 1; }\nexport function work(): number { return helper(); }\n',
    'utf8',
  );
  writeFileSync(
    join(root, 'src/b.ts'),
    'function helper(): number { return 22; }\nexport function work(): number { return helper(); }\n',
    'utf8',
  );
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function findOcc(catalog: Catalog, name: string, filePath: string): FunctionOccurrence | undefined {
  return catalog.functions[name]?.find((o) => o.filePath === filePath);
}

describe('body-twin edge keying', () => {
  it('keeps each twin occurrence’s edges to its own file, not the union', async () => {
    const discovery = typescriptGraphAdapter.discoverFiles({ cwd: root });
    const parsed = typescriptGraphAdapter.parseProject({
      projectDirAbs: discovery.projectDirAbs,
      files: discovery.files,
      compilerOptions: discovery.compilerOptions,
      resolutionMode: 'exact',
    });
    const walked = typescriptGraphAdapter.walkProject({
      project: parsed.project,
      projectDirAbs: discovery.projectDirAbs,
      files: discovery.files,
    });
    const catalog: Catalog = {
      version: '3.0',
      tool: 'graph',
      language: 'typescript',
      builtAt: 'x',
      cacheKey: 't',
      functions: walked.occurrences,
    };
    const { edgesByOwner } = await typescriptGraphAdapter.resolveCallSites({
      project: parsed.project,
      catalog,
      callSites: walked.callSites,
      dependencySites: walked.dependencySites,
      projectDirAbs: discovery.projectDirAbs,
      resolutionMode: 'exact',
    });

    const workA = findOcc(catalog, 'work', 'src/a.ts');
    const workB = findOcc(catalog, 'work', 'src/b.ts');
    const helperA = findOcc(catalog, 'helper', 'src/a.ts');
    const helperB = findOcc(catalog, 'helper', 'src/b.ts');
    // The two work occurrences are genuinely body-twins (same hash, different file).
    expect(workA?.bodyHash).toBe(workB?.bodyHash);
    expect(helperA?.bodyHash).not.toBe(helperB?.bodyHash);

    const edgesA = edgesByOwner.get(ownerEdgeKey(workA!.bodyHash, 'src/a.ts')) ?? [];
    const edgesB = edgesByOwner.get(ownerEdgeKey(workB!.bodyHash, 'src/b.ts')) ?? [];
    const targetsA = edgesA.flatMap((e) => e.to);
    const targetsB = edgesB.flatMap((e) => e.to);

    expect(targetsA).toContain(helperA!.bodyHash);
    expect(targetsA).not.toContain(helperB!.bodyHash); // no phantom edge into b's helper
    expect(targetsB).toContain(helperB!.bodyHash);
    expect(targetsB).not.toContain(helperA!.bodyHash);
  });
});
