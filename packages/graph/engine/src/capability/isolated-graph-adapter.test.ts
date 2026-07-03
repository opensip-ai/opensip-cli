import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isolatedGraphAdapterBridge } from './isolated-graph-adapter.js';

import type { ParseOutput, ResolveOutput, WalkOutput } from '../lang-adapter/types.js';
import type { CapabilityHostBridgeContext, CapabilityWorkerBridgeContext } from '@opensip-cli/core';

let root: string;
let packageDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'opensip-graph-bridge-'));
  packageDir = join(root, 'node_modules', '@acme', 'graph-adapter');
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(
    join(packageDir, 'package.json'),
    JSON.stringify({
      name: '@acme/graph-adapter',
      type: 'module',
      main: './index.mjs',
    }),
  );
  writeFileSync(
    join(packageDir, 'index.mjs'),
    `
      export const adapter = {
        id: 'fixture',
        displayName: 'Fixture Graph',
        fileExtensions: ['.fixture'],
        ruleHints: { ignoreGenerated: true },
        discoverFiles() {
          return { projectDirAbs: '${root}', files: ['${join(root, 'a.fixture')}'] };
        },
        parseProject(input) {
          return { project: { input, opaque: () => 'not serializable' }, parseErrors: [] };
        },
        walkProject() {
          return {
            occurrences: {},
            callSites: [{ nodeRef: () => 'opaque', sourceFileRef: () => 'opaque', ownerHash: 'h', kind: 'call' }],
            parseErrors: [],
          };
        },
        resolveCallSites(input) {
          return {
            edgesByOwner: new Map(),
            stats: {
              totalCallSites: input.callSites.length,
              resolvedHigh: 0,
              resolvedMedium: 0,
              resolvedLow: 0,
              unresolved: input.callSites.length,
            },
          };
        },
        cacheKey() {
          return 'fixture-key';
        },
      };
    `,
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function context(request: unknown): CapabilityWorkerBridgeContext {
  return {
    domainId: 'graph-adapter',
    descriptor: {
      discovery: { mode: 'marker', markerKind: 'graph-adapter' },
      exportName: 'adapter',
      exportShape: 'single',
      configKeys: {},
    },
    pkg: { name: '@acme/graph-adapter', packageDir },
    resourceDecision: {
      isolation: 'worker',
      allowedResources: [],
      denyUndeclared: true,
      reasons: ['test'],
    },
    request,
  };
}

function hostContext(invoke: CapabilityHostBridgeContext['invoke']): CapabilityHostBridgeContext {
  const base = context({ kind: 'graph.discover' });
  return {
    domainId: base.domainId,
    descriptor: base.descriptor,
    pkg: base.pkg,
    resourceDecision: base.resourceDecision,
    invoke,
  };
}

describe('isolatedGraphAdapterBridge', () => {
  it('discovers adapters and creates host proxy contributions', async () => {
    const calls: unknown[] = [];
    const contributions = await isolatedGraphAdapterBridge.createHostContributions(
      hostContext(async (request) => {
        calls.push(request);
        if ((request as { kind?: unknown }).kind === 'graph.discover') {
          return await isolatedGraphAdapterBridge.runInWorker(context(request));
        }
        return 'proxy-result';
      }),
    );

    const adapter = contributions[0]?.contribution as {
      id: string;
      displayName?: string;
      fileExtensions: readonly string[];
      ruleHints?: unknown;
      cacheKey: (input: unknown) => Promise<unknown>;
    };

    expect(adapter).toMatchObject({
      id: 'fixture',
      displayName: 'Fixture Graph',
      fileExtensions: ['.fixture'],
      ruleHints: { ignoreGenerated: true },
    });
    await expect(adapter.cacheKey({ projectDirAbs: root })).resolves.toBe('proxy-result');
    expect(calls).toEqual([
      { kind: 'graph.discover' },
      { kind: 'graph.cacheKey', input: { projectDirAbs: root } },
    ]);
  });

  it('dispatches non-handle worker requests directly to the adapter', async () => {
    await expect(
      isolatedGraphAdapterBridge.runInWorker(
        context({ kind: 'graph.discoverFiles', input: { projectDirAbs: root } }),
      ),
    ).resolves.toEqual({
      projectDirAbs: root,
      files: [join(root, 'a.fixture')],
    });
    await expect(
      isolatedGraphAdapterBridge.runInWorker(
        context({
          kind: 'graph.walkProject',
          input: { project: { direct: true }, projectDirAbs: root, files: [] },
        }),
      ),
    ).resolves.toMatchObject({
      callSites: [{ ownerHash: 'h', kind: 'call' }],
      parseErrors: [],
    });
    await expect(
      isolatedGraphAdapterBridge.runInWorker(
        context({
          kind: 'graph.resolveCallSites',
          input: {
            project: { direct: true },
            callSites: [],
            projectDirAbs: root,
            resolutionMode: 'exact',
          },
        }),
      ),
    ).resolves.toMatchObject({
      stats: { totalCallSites: 0 },
    });
    await expect(
      isolatedGraphAdapterBridge.runInWorker(
        context({ kind: 'graph.cacheKey', input: { projectDirAbs: root } }),
      ),
    ).resolves.toBe('fixture-key');
    await expect(
      isolatedGraphAdapterBridge.runInWorker(context({ kind: 'unknown' })),
    ).rejects.toThrow('unknown graph capability worker request');
  });

  it('keeps adapter project and call-site handles worker-local', async () => {
    const parseInput = {
      projectDirAbs: root,
      files: [join(root, 'a.fixture')],
      resolutionMode: 'exact' as const,
    };
    const parsed = (await isolatedGraphAdapterBridge.runInWorker(
      context({ kind: 'graph.parseProject', input: parseInput }),
    )) as ParseOutput<unknown>;

    expect(parsed.parseErrors).toEqual([]);
    expect(parsed.project).toMatchObject({
      __opensipCapabilityGraphProject: true,
      parseInput,
    });
    expect((parsed.project as { opaque?: unknown }).opaque).toBeUndefined();

    const walked = (await isolatedGraphAdapterBridge.runInWorker(
      context({
        kind: 'graph.walkProject',
        input: {
          project: parsed.project,
          projectDirAbs: root,
          files: [join(root, 'a.fixture')],
        },
      }),
    )) as WalkOutput;

    expect(walked.callSites).toEqual([]);
    expect(walked.parseErrors).toEqual([]);

    const resolved = (await isolatedGraphAdapterBridge.runInWorker(
      context({
        kind: 'graph.resolveCallSites',
        input: {
          project: parsed.project,
          catalog: {
            version: '3.0',
            tool: 'graph',
            language: 'fixture',
            builtAt: '2026-07-02T00:00:00.000Z',
            cacheKey: 'fixture-key',
            functions: {},
          },
          callSites: walked.callSites,
          projectDirAbs: root,
          resolutionMode: 'exact',
        },
      }),
    )) as ResolveOutput;

    expect(resolved.stats.totalCallSites).toBe(1);
  });
});
