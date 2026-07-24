import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isolatedSimPackBridge } from './isolated-sim-pack.js';
import { ScenarioAbortedError } from '../framework/execution/scenario-aborted-error.js';

import type { CapabilityHostBridgeContext, CapabilityWorkerBridgeContext } from '@opensip-cli/core';

let root: string;
let packageDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'opensip-sim-bridge-'));
  packageDir = join(root, 'node_modules', '@acme', 'sim-pack');
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(
    join(packageDir, 'package.json'),
    JSON.stringify({ name: '@acme/sim-pack', type: 'module', main: './index.mjs' }),
  );
  writeFileSync(
    join(packageDir, 'index.mjs'),
    `
      export const scenarios = [
        {
          kind: 'load',
          id: 'fixture-scenario',
          name: 'Fixture',
          description: 'fixture',
          tags: ['smoke'],
          run(signal) {
            return Promise.resolve({
              scenarioId: 'fixture-scenario',
              ok: !signal.aborted,
              assertions: [],
            });
          },
        },
        { id: 'not-a-scenario' },
      ];
      export const recipes = [{ id: 'recipe-one' }];
    `,
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function workerContext(request: unknown): CapabilityWorkerBridgeContext {
  return {
    domainId: 'sim-pack',
    descriptor: {
      discovery: { mode: 'marker', markerKind: 'sim-pack' },
      exportName: 'scenarios',
      exportShape: 'array',
      configKeys: {},
      coContributions: [{ domainId: 'recipes', exportName: 'recipes', exportShape: 'array' }],
    },
    pkg: { name: '@acme/sim-pack', packageDir },
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
  const base = workerContext({ kind: 'simulation.discover' });
  return {
    domainId: base.domainId,
    descriptor: base.descriptor,
    pkg: base.pkg,
    resourceDecision: base.resourceDecision,
    invoke,
  };
}

describe('isolatedSimPackBridge', () => {
  it('discovers scenarios and co-contributions inside the worker', async () => {
    await expect(
      isolatedSimPackBridge.runInWorker(workerContext({ kind: 'simulation.discover' })),
    ).resolves.toEqual({
      scenarios: [
        {
          kind: 'load',
          id: 'fixture-scenario',
          name: 'Fixture',
          description: 'fixture',
          tags: ['smoke'],
        },
      ],
      coContributions: [{ targetDomainId: 'recipes', contribution: { id: 'recipe-one' } }],
    });
  });

  it('runs scenarios inside the worker and rejects unknown requests', async () => {
    await expect(
      isolatedSimPackBridge.runInWorker(
        workerContext({ kind: 'simulation.run', scenarioId: 'fixture-scenario' }),
      ),
    ).resolves.toEqual({
      scenarioId: 'fixture-scenario',
      ok: true,
      assertions: [],
    });
    await expect(
      isolatedSimPackBridge.runInWorker(
        workerContext({ kind: 'simulation.run', scenarioId: 'missing' }),
      ),
    ).rejects.toThrow("capability pack @acme/sim-pack has no scenario 'missing'");
    await expect(
      isolatedSimPackBridge.runInWorker(workerContext({ kind: 'unknown' })),
    ).rejects.toThrow('unknown simulation capability worker request');
  });

  it('creates host proxy scenarios that invoke the worker', async () => {
    const calls: unknown[] = [];
    const contributions = await isolatedSimPackBridge.createHostContributions(
      hostContext(async (request) => {
        calls.push(request);
        if ((request as { kind?: unknown }).kind === 'simulation.discover') {
          return await isolatedSimPackBridge.runInWorker(workerContext(request));
        }
        return { scenarioId: 'fixture-scenario', ok: true, assertions: [] };
      }),
    );

    const scenario = contributions[0]?.contribution as {
      run: (signal: AbortSignal) => Promise<unknown>;
    };
    await expect(scenario.run(new AbortController().signal)).resolves.toEqual({
      scenarioId: 'fixture-scenario',
      ok: true,
      assertions: [],
    });
    expect(calls).toEqual([
      { kind: 'simulation.discover' },
      { kind: 'simulation.run', scenarioId: 'fixture-scenario' },
    ]);
  });

  it('rejects the proxy run immediately when the signal is already aborted', async () => {
    const invoke = async (): Promise<unknown> => {
      // Should never be called — an already-aborted signal must short-circuit
      // before the RPC is even issued.
      throw new Error('invoke should not run when pre-aborted');
    };
    const contributions = await isolatedSimPackBridge.createHostContributions(
      hostContext(async (request) => {
        if ((request as { kind?: unknown }).kind === 'simulation.discover') {
          return await isolatedSimPackBridge.runInWorker(workerContext(request));
        }
        return invoke();
      }),
    );

    const scenario = contributions[0]?.contribution as {
      run: (signal: AbortSignal) => Promise<unknown>;
    };
    const ac = new AbortController();
    ac.abort();
    await expect(scenario.run(ac.signal)).rejects.toThrow(ScenarioAbortedError);
  });

  it('rejects the proxy run promptly when the signal aborts mid-flight, without waiting on the RPC', async () => {
    // The RPC promise never resolves on its own (simulating a worker that
    // never hears about the host abort — the bridge has no cancellation
    // channel today). Without the fix, `run()` would hang forever.
    let rpcRejectFromDiscover = false;
    const contributions = await isolatedSimPackBridge.createHostContributions(
      hostContext(async (request) => {
        if ((request as { kind?: unknown }).kind === 'simulation.discover') {
          rpcRejectFromDiscover = true;
          return await isolatedSimPackBridge.runInWorker(workerContext(request));
        }
        // Never resolves/rejects — simulates a worker RPC hanging forever.
        return new Promise(() => {});
      }),
    );
    expect(rpcRejectFromDiscover).toBe(true);

    const scenario = contributions[0]?.contribution as {
      run: (signal: AbortSignal) => Promise<unknown>;
    };
    const ac = new AbortController();
    const runPromise = scenario.run(ac.signal);
    queueMicrotask(() => ac.abort());

    await expect(runPromise).rejects.toThrow(ScenarioAbortedError);
  });
});
