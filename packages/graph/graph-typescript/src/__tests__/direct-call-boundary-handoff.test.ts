import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ownerEdgeKey } from '@opensip-cli/graph';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { typescriptGraphAdapter } from '../index.js';

import { findOccurrence, writeFixture } from './acceptance/_fixture-runner.js';

import type { Catalog, ResolveOutput } from '@opensip-cli/graph';

describe('imported direct-call boundary handoff', () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'graph-direct-boundary-'));
  afterAll(() => {
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  writeFixture(fixtureDir, {
    'workspace-api.d.ts': [
      `declare module '@fixture/workspace-api' {`,
      `  export function workspaceHelper(): number;`,
      `}`,
    ].join('\n'),
    'shim.ts': `export { workspaceHelper as helper } from '@fixture/workspace-api';\n`,
    'decoy.ts': `export function helper(): number { return -1; }\n`,
    'caller.ts': [
      `import { helper } from './shim.js';`,
      `export function caller(): number { return helper(); }`,
    ].join('\n'),
  });

  let catalog!: Catalog;
  let resolved!: ResolveOutput;
  beforeAll(async () => {
    const discovery = await typescriptGraphAdapter.discoverFiles({
      cwd: fixtureDir,
      diagnosticIntent: 'quiet',
    });
    const parsed = await typescriptGraphAdapter.parseProject({
      projectDirAbs: discovery.projectDirAbs,
      files: discovery.files,
      configPathAbs: discovery.configPathAbs,
      compilerOptions: discovery.compilerOptions,
      resolutionMode: 'exact',
    });
    const walked = await typescriptGraphAdapter.walkProject({
      project: parsed.project,
      projectDirAbs: discovery.projectDirAbs,
      files: discovery.files,
    });
    catalog = {
      version: '3.0',
      tool: 'graph',
      language: 'typescript',
      builtAt: 'test',
      cacheKey: 'test',
      resolutionMode: 'exact',
      functions: walked.occurrences,
      reExports: walked.reExports,
    };
    resolved = await typescriptGraphAdapter.resolveCallSites({
      project: parsed.project,
      catalog,
      callSites: walked.callSites,
      dependencySites: walked.dependencySites,
      projectDirAbs: discovery.projectDirAbs,
      resolutionMode: 'exact',
      emitBoundaryCalls: true,
    });
  });

  it('declines a relative-shim miss instead of selecting a repo-wide name decoy', () => {
    const caller = findOccurrence(catalog, (occurrence) => occurrence.simpleName === 'caller');
    const decoy = findOccurrence(
      catalog,
      (occurrence) => occurrence.simpleName === 'helper' && occurrence.filePath === 'decoy.ts',
    );
    expect(caller).toBeDefined();
    expect(decoy).toBeDefined();

    const ownerKey = ownerEdgeKey(caller!.bodyHash, caller!.filePath, caller!.line, caller!.column);
    const helperEdge = resolved.edgesByOwner
      .get(ownerKey)
      ?.find((edge) => edge.text.includes('helper'));
    expect(helperEdge).toBeDefined();
    expect(helperEdge!.to).toEqual([]);
    expect(helperEdge!.to).not.toContain(decoy!.bodyHash);
  });

  it('emits the unresolved relative-shim call for global boundary recovery', () => {
    expect(resolved.boundaryCalls).toEqual([
      expect.objectContaining({
        ownerFile: 'caller.ts',
        calleeName: 'helper',
        importSpecifier: './shim.js',
        text: 'helper()',
      }),
    ]);
  });
});
