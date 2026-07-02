import { pathToFileURL } from 'node:url';

import {
  resolvePackageEntryPoint,
  type CapabilityBridgeContribution,
  type CapabilityIsolationBridge,
} from '@opensip-cli/core';

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

/**
 * Import an isolated sim-pack module from its declared package entry point.
 *
 * @throws {TypeError} when the package has no readable entry point.
 */
async function importPackageModule(
  packageDir: string,
  packageName: string,
): Promise<Record<string, unknown>> {
  const resolved = resolvePackageEntryPoint(packageDir, packageName);
  if (resolved === undefined) {
    throw new TypeError(`package ${packageName} has no readable entry point`);
  }
  return (await import(pathToFileURL(resolved.entry).href)) as Record<string, unknown>;
}

/**
 * Read an array-shaped export from a sim-pack module.
 *
 * @throws {TypeError} when the export is missing or not an array.
 */
function asArrayExport(mod: Record<string, unknown>, exportName: string): readonly unknown[] {
  const value = mod[exportName];
  if (!Array.isArray(value)) {
    throw new TypeError(`capability pack export '${exportName}' must be an array`);
  }
  return value;
}

function coContributionValues(value: unknown, exportShape: 'array' | 'single'): readonly unknown[] {
  if (value === undefined) return [];
  if (exportShape === 'single') return [value];
  return Array.isArray(value) ? value : [];
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

function createProxyScenario(
  descriptor: SimScenarioDescriptor,
  invoke: (request: unknown) => Promise<unknown>,
): RunnableScenario {
  return {
    ...descriptor,
    run: async (_abortSignal: AbortSignal): Promise<ScenarioExecutorResult> =>
      (await invoke({
        kind: 'simulation.run',
        scenarioId: descriptor.id,
      } satisfies SimRunRequest)) as ScenarioExecutorResult,
  };
}

async function discoverWorkerContributions(
  args: Parameters<CapabilityIsolationBridge['runInWorker']>[0],
): Promise<SimDiscoverResult> {
  const mod = await importPackageModule(args.pkg.packageDir, args.pkg.name);
  const scenarios = asArrayExport(mod, args.descriptor.exportName).filter(isScenario);
  const coContributions = (args.descriptor.coContributions ?? []).flatMap((co) => {
    const value = mod[co.exportName];
    const values = coContributionValues(value, co.exportShape);
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
  const mod = await importPackageModule(args.pkg.packageDir, args.pkg.name);
  const scenarios = asArrayExport(mod, args.descriptor.exportName).filter(isScenario);
  const scenario = scenarios.find((candidate) => candidate.id === request.scenarioId);
  if (scenario === undefined) {
    throw new Error(`capability pack ${args.pkg.name} has no scenario '${request.scenarioId}'`);
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
