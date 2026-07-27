import {
  capabilityCoContributionValues,
  createToolError,
  importCapabilityPackageModule,
  readCapabilityArrayExport,
  type CapabilityBridgeContribution,
  type CapabilityIsolationBridge,
} from '@opensip-cli/core';

import { simulationErrorCatalog } from '../errors/simulation-error-catalog.js';
import { ScenarioAbortedError } from '../framework/execution/scenario-aborted-error.js';

import type { RunnableScenario } from '../framework/runnable-scenario.js';
import type { ScenarioExecutorResult } from '../framework/scenario-executor-result.js';

interface SimDiscoverRequest {
  readonly kind: 'simulation.discover';
}

interface SimRunRequest {
  readonly kind: 'simulation.run';
  readonly scenarioId: string;
}

type SimWorkerRequest = SimDiscoverRequest | SimRunRequest;

interface SimScenarioDescriptor {
  readonly kind: RunnableScenario['kind'];
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly tags: readonly string[];
}

interface SimDiscoverResult {
  readonly scenarios: readonly SimScenarioDescriptor[];
  readonly coContributions: readonly {
    readonly targetDomainId: string;
    readonly contribution: unknown;
  }[];
}

function isScenario(value: unknown): value is RunnableScenario {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.kind === 'string' &&
    typeof record.id === 'string' &&
    typeof record.name === 'string' &&
    typeof record.description === 'string' &&
    Array.isArray(record.tags) &&
    typeof record.run === 'function'
  );
}

function descriptorFromScenario(scenario: RunnableScenario): SimScenarioDescriptor {
  return {
    kind: scenario.kind,
    id: scenario.id,
    name: scenario.name,
    description: scenario.description,
    tags: scenario.tags,
  };
}

/**
 * Invoke the worker-hosted scenario, racing it against the host abort
 * signal so the caller is never left hanging.
 *
 * NOTE: `CapabilityHostBridgeContext.invoke` (the bridge RPC surface, see
 * `@opensip-cli/core`'s `tools/capability.ts`) takes a bare `request:
 * unknown` with no cancellation channel — there is no way to forward an
 * abort into the in-flight worker call. So this can only reject the HOST
 * side promptly; the worker keeps executing the scenario to completion (or
 * its own internal timeout) with no signal that the host gave up. True
 * worker-side cancellation requires the bridge contract itself to grow an
 * abort parameter on `invoke` and thread it through the worker RPC.
 */
function runProxiedScenario(
  descriptor: SimScenarioDescriptor,
  invoke: (request: unknown) => Promise<unknown>,
  abortSignal: AbortSignal,
): Promise<ScenarioExecutorResult> {
  if (abortSignal.aborted) {
    return Promise.reject(new ScenarioAbortedError(descriptor.id));
  }

  return new Promise<ScenarioExecutorResult>((resolve, reject) => {
    const onAbort = (): void => {
      reject(new ScenarioAbortedError(descriptor.id));
    };
    abortSignal.addEventListener('abort', onAbort, { once: true });

    invoke({
      kind: 'simulation.run',
      scenarioId: descriptor.id,
    } satisfies SimRunRequest)
      .then((result) => resolve(result as ScenarioExecutorResult))
      .catch((error: unknown) => {
        reject(error instanceof Error ? error : new Error(String(error)));
      })
      .finally(() => {
        abortSignal.removeEventListener('abort', onAbort);
      });
  });
}

function createProxyScenario(
  descriptor: SimScenarioDescriptor,
  invoke: (request: unknown) => Promise<unknown>,
): RunnableScenario {
  return {
    ...descriptor,
    run: (abortSignal: AbortSignal): Promise<ScenarioExecutorResult> =>
      runProxiedScenario(descriptor, invoke, abortSignal),
  };
}

async function discoverWorkerContributions(
  args: Parameters<CapabilityIsolationBridge['runInWorker']>[0],
): Promise<SimDiscoverResult> {
  const mod = await importCapabilityPackageModule(args.pkg);
  const scenarios = readCapabilityArrayExport(mod, args.descriptor.exportName).filter(isScenario);
  const coContributions = (args.descriptor.coContributions ?? []).flatMap((co) => {
    const value = mod[co.exportName];
    const values = capabilityCoContributionValues(value, co.exportShape);
    return values.map((contribution) => ({ targetDomainId: co.domainId, contribution }));
  });
  return {
    scenarios: scenarios.map(descriptorFromScenario),
    coContributions,
  };
}

/**
 * Run one proxied scenario request inside the worker process.
 *
 * @throws {Error} when the requested scenario id is not exported by the pack.
 */
async function runWorkerScenario(
  args: Parameters<CapabilityIsolationBridge['runInWorker']>[0],
  request: SimRunRequest,
): Promise<ScenarioExecutorResult> {
  const mod = await importCapabilityPackageModule(args.pkg);
  const scenarios = readCapabilityArrayExport(mod, args.descriptor.exportName).filter(isScenario);
  const scenario = scenarios.find((candidate) => candidate.id === request.scenarioId);
  if (scenario === undefined) {
    throw createToolError(
      simulationErrorCatalog.require('SIMULATION.CAPABILITY.SCENARIO_NOT_FOUND'),
      `Capability pack ${args.pkg.name} has no scenario '${request.scenarioId}'.`,
      { metadata: { packageName: args.pkg.name, scenarioId: request.scenarioId } },
    );
  }
  const abortController = new AbortController();
  try {
    return await scenario.run(abortController.signal);
  } finally {
    abortController.abort();
  }
}

async function createHostContributions(
  context: Parameters<CapabilityIsolationBridge['createHostContributions']>[0],
): Promise<readonly CapabilityBridgeContribution[]> {
  const result = (await context.invoke({
    kind: 'simulation.discover',
  } satisfies SimDiscoverRequest)) as SimDiscoverResult;
  return [
    ...result.scenarios.map((descriptor) => ({
      contribution: createProxyScenario(descriptor, context.invoke),
    })),
    ...result.coContributions,
  ];
}

/**
 * Dispatch a worker-side sim-pack request.
 *
 * @throws {Error} when the request kind is unknown.
 */
async function runInWorker(
  context: Parameters<CapabilityIsolationBridge['runInWorker']>[0],
): Promise<unknown> {
  const request = context.request as SimWorkerRequest;
  if (request.kind === 'simulation.discover') return await discoverWorkerContributions(context);
  if (request.kind === 'simulation.run') return await runWorkerScenario(context, request);
  throw new Error('unknown simulation capability worker request');
}

/** Worker-isolation bridge for external sim-pack contributions. */
export const isolatedSimPackBridge: CapabilityIsolationBridge = {
  createHostContributions,
  runInWorker,
};
