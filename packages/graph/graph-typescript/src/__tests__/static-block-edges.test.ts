/**
 * Regression: a class `static {}` block must get an incoming creation edge.
 *
 * `<static-init>` occurrences are emitted by the inventory visitor, but
 * `isInlineCallable` — the gate for the parent → nested-callable 'creation'
 * edge — did not list `ts.isClassStaticBlockDeclaration`. A static block
 * therefore had ZERO incoming edges, so it (and anything reachable only
 * from it) looked unreachable to `graph:orphan-subtree`'s BFS, even though
 * a static block always runs at class-evaluation time.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ownerEdgeKey } from '@opensip-cli/graph';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { typescriptGraphAdapter } from '../index.js';

import type { Catalog, FunctionOccurrence } from '@opensip-cli/graph';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'graph-ts-static-block-'));
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
  // `onlyFromStatic` is reachable ONLY through the static block.
  writeFileSync(
    join(root, 'src/a.ts'),
    'function onlyFromStatic(): number { return 7; }\n' +
      'export class C {\n' +
      '  static x = 0;\n' +
      '  static { C.x = onlyFromStatic(); }\n' +
      '}\n',
    'utf8',
  );
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function findOcc(catalog: Catalog, name: string, filePath: string): FunctionOccurrence | undefined {
  return catalog.functions[name]?.find((o) => o.filePath === filePath);
}

describe('class static-init block edges', () => {
  it('records a creation edge into <static-init> so its subtree is reachable', async () => {
    const discovery = await typescriptGraphAdapter.discoverFiles({
      cwd: root,
      diagnosticIntent: 'quiet',
    });
    const parsed = await typescriptGraphAdapter.parseProject({
      projectDirAbs: discovery.projectDirAbs,
      files: discovery.files,
      compilerOptions: discovery.compilerOptions,
      resolutionMode: 'exact',
    });
    const walked = await typescriptGraphAdapter.walkProject({
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

    const staticInit = findOcc(catalog, '<static-init>', 'src/a.ts');
    expect(staticInit).toBeDefined();
    const helper = findOcc(catalog, 'onlyFromStatic', 'src/a.ts');
    expect(helper).toBeDefined();

    // Every occurrence that is not the module-init must have at least one
    // incoming edge, or the orphan rule flags its whole subtree.
    const incoming = new Set<string>();
    for (const edges of edgesByOwner.values()) {
      for (const edge of edges) {
        for (const to of edge.to) incoming.add(to);
      }
    }
    expect(incoming.has(staticInit!.bodyHash)).toBe(true);

    // And the static block still owns its own call edge to the helper, so the
    // helper is transitively reachable through it.
    const blockEdges =
      edgesByOwner.get(
        ownerEdgeKey(staticInit!.bodyHash, 'src/a.ts', staticInit!.line, staticInit!.column),
      ) ?? [];
    expect(blockEdges.flatMap((e) => e.to)).toContain(helper!.bodyHash);
  });
});
