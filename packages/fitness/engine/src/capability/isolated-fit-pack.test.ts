import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isolatedFitPackBridge } from './isolated-fit-pack.js';

import type { CapabilityHostBridgeContext, CapabilityWorkerBridgeContext } from '@opensip-cli/core';

let root: string;
let packageDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'opensip-fit-bridge-'));
  packageDir = join(root, 'node_modules', '@acme', 'fit-pack');
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(
    join(packageDir, 'package.json'),
    JSON.stringify({ name: '@acme/fit-pack', type: 'module', main: './index.mjs' }),
  );
  writeFileSync(
    join(packageDir, 'index.mjs'),
    `
      export const checks = [
        {
          config: {
            id: 'CHK_fixture',
            slug: 'fixture-check',
            tags: ['quality'],
            description: 'fixture',
            analysisMode: 'analyze',
            scope: { type: 'all' },
            itemType: 'file',
            execute() { throw new Error('execute should not run'); },
          },
          getScope() { return { type: 'all' }; },
          getMatcher() { return { matches: () => true }; },
          run(cwd, options) {
            return Promise.resolve({
              checkId: 'CHK_fixture',
              ruleId: 'fixture-check',
              status: 'passed',
              violations: [],
              metadata: { cwd, options },
            });
          },
        },
        { config: { id: 'not-a-check' } },
      ];
      export const recipes = [{ id: 'recipe-one' }];
      export const singleRecipe = { id: 'recipe-two' };
    `,
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function workerContext(request: unknown): CapabilityWorkerBridgeContext {
  return {
    domainId: 'fit-pack',
    descriptor: {
      discovery: { mode: 'marker', markerKind: 'fit-pack' },
      exportName: 'checks',
      exportShape: 'array',
      configKeys: {},
      coContributions: [
        { domainId: 'recipes', exportName: 'recipes', exportShape: 'array' },
        { domainId: 'recipes', exportName: 'singleRecipe', exportShape: 'single' },
      ],
    },
    pkg: { name: '@acme/fit-pack', packageDir },
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
  const base = workerContext({ kind: 'fitness.discover' });
  return {
    domainId: base.domainId,
    descriptor: base.descriptor,
    pkg: base.pkg,
    resourceDecision: base.resourceDecision,
    invoke,
  };
}

describe('isolatedFitPackBridge', () => {
  it('discovers checks and co-contributions inside the worker', async () => {
    await expect(
      isolatedFitPackBridge.runInWorker(workerContext({ kind: 'fitness.discover' })),
    ).resolves.toEqual({
      checks: [
        {
          config: {
            id: 'CHK_fixture',
            slug: 'fixture-check',
            tags: ['quality'],
            description: 'fixture',
            analysisMode: 'analyze',
            scope: { type: 'all' },
            itemType: 'file',
          },
        },
      ],
      coContributions: [
        { targetDomainId: 'recipes', contribution: { id: 'recipe-one' } },
        { targetDomainId: 'recipes', contribution: { id: 'recipe-two' } },
      ],
    });
  });

  it('runs a requested check inside the worker and rejects unknown requests', async () => {
    await expect(
      isolatedFitPackBridge.runInWorker(
        workerContext({
          kind: 'fitness.run',
          checkId: 'CHK_fixture',
          cwd: root,
          options: { verbose: true, targetFiles: ['a.ts'], ignored: 'dropped' },
        }),
      ),
    ).resolves.toMatchObject({
      checkId: 'CHK_fixture',
      metadata: {
        cwd: root,
        options: { verbose: true, targetFiles: ['a.ts'] },
      },
    });

    await expect(
      isolatedFitPackBridge.runInWorker(
        workerContext({ kind: 'fitness.run', checkId: 'missing', cwd: root }),
      ),
    ).rejects.toThrow("capability pack @acme/fit-pack has no check 'missing'");
    await expect(
      isolatedFitPackBridge.runInWorker(workerContext({ kind: 'unknown' })),
    ).rejects.toThrow('unknown fitness capability worker request');
  });

  it('creates host proxy checks that invoke the worker instead of execute()', async () => {
    const calls: unknown[] = [];
    const contributions = await isolatedFitPackBridge.createHostContributions(
      hostContext(async (request) => {
        calls.push(request);
        if ((request as { kind?: unknown }).kind === 'fitness.discover') {
          return await isolatedFitPackBridge.runInWorker(workerContext(request));
        }
        return { status: 'passed', violations: [] };
      }),
    );

    const check = contributions[0]?.contribution as {
      run: (cwd: string, options?: unknown) => Promise<unknown>;
      config: { execute: () => never };
    };
    await expect(check.run(root, { globalExcludes: ['dist/**'] })).resolves.toEqual({
      status: 'passed',
      violations: [],
    });
    expect(calls).toEqual([
      { kind: 'fitness.discover' },
      {
        kind: 'fitness.run',
        checkId: 'CHK_fixture',
        cwd: root,
        options: { globalExcludes: ['dist/**'] },
      },
    ]);
    expect(() => check.config.execute()).toThrow(
      "isolated check 'fixture-check' must be run through check.run()",
    );
  });
});
