import {
  capabilityCoContributionValues,
  importCapabilityPackageModule,
  readCapabilityArrayExport,
  type CapabilityBridgeContribution,
  type CapabilityIsolationBridge,
} from '@opensip-cli/core';

import { isCheck, type Check, type CheckConfig } from '../framework/check-types.js';
import { PathMatcher } from '../framework/path-matcher.js';

import type { RunOptions } from '../framework/execution-context.js';
import type { CheckResult } from '../types/findings.js';

type SerializableCheckConfig = Omit<CheckConfig, 'execute'>;

interface FitnessDiscoverRequest {
  readonly kind: 'fitness.discover';
}

interface FitnessRunRequest {
  readonly kind: 'fitness.run';
  readonly checkId: string;
  readonly cwd: string;
  readonly options?: SerializableRunOptions;
}

type FitnessWorkerRequest = FitnessDiscoverRequest | FitnessRunRequest;

interface FitnessDiscoverResult {
  readonly checks: readonly { readonly config: SerializableCheckConfig }[];
  readonly coContributions: readonly {
    readonly targetDomainId: string;
    readonly contribution: unknown;
  }[];
}

type SerializableRunOptions = Pick<
  RunOptions,
  'verbose' | 'scopeOverride' | 'additionalExcludes' | 'targetFiles' | 'globalExcludes'
>;

/**
 * Prevent the legacy `execute` path from running an isolated check in-process.
 *
 * @throws {TypeError} always; isolated checks must go through `check.run()`.
 */
function denyIsolatedCheckExecute(slug: string): never {
  throw new TypeError(`isolated check '${slug}' must be run through check.run()`);
}

function serializableConfig(check: Check): SerializableCheckConfig {
  const { execute, ...config } = check.config;
  void execute;
  return config;
}

function serializableRunOptions(
  options: RunOptions | undefined,
): SerializableRunOptions | undefined {
  if (options === undefined) return undefined;
  return {
    ...(options.verbose === undefined ? {} : { verbose: options.verbose }),
    ...(options.scopeOverride === undefined ? {} : { scopeOverride: options.scopeOverride }),
    ...(options.additionalExcludes === undefined
      ? {}
      : { additionalExcludes: options.additionalExcludes }),
    ...(options.targetFiles === undefined ? {} : { targetFiles: options.targetFiles }),
    ...(options.globalExcludes === undefined ? {} : { globalExcludes: options.globalExcludes }),
  };
}

function createProxyCheck(
  config: SerializableCheckConfig,
  invoke: (request: unknown) => Promise<unknown>,
): Check {
  return {
    config: {
      ...config,
      execute: () => denyIsolatedCheckExecute(config.slug),
    },
    getScope: () => config.scope,
    getMatcher: (cwd: string) =>
      PathMatcher.create({
        include: [],
        exclude: [],
        cwd,
      }),
    run: async (cwd: string, options?: RunOptions): Promise<CheckResult> =>
      (await invoke({
        kind: 'fitness.run',
        checkId: config.id,
        cwd,
        options: serializableRunOptions(options),
      } satisfies FitnessRunRequest)) as CheckResult,
  };
}

async function discoverWorkerContributions(
  args: Parameters<CapabilityIsolationBridge['runInWorker']>[0],
): Promise<FitnessDiscoverResult> {
  const mod = await importCapabilityPackageModule(args.pkg);
  const checks = readCapabilityArrayExport(mod, args.descriptor.exportName).filter(isCheck);
  const coContributions = (args.descriptor.coContributions ?? []).flatMap((co) => {
    const value = mod[co.exportName];
    const values = capabilityCoContributionValues(value, co.exportShape);
    return values.map((contribution) => ({ targetDomainId: co.domainId, contribution }));
  });
  return {
    checks: checks.map((check) => ({ config: serializableConfig(check) })),
    coContributions,
  };
}

/**
 * Run one proxied check request inside the worker process.
 *
 * @throws {Error} when the requested check id is not exported by the pack.
 */
async function runWorkerCheck(
  args: Parameters<CapabilityIsolationBridge['runInWorker']>[0],
  request: FitnessRunRequest,
): Promise<CheckResult> {
  const mod = await importCapabilityPackageModule(args.pkg);
  const checks = readCapabilityArrayExport(mod, args.descriptor.exportName).filter(isCheck);
  const check = checks.find((candidate) => candidate.config.id === request.checkId);
  if (check === undefined) {
    throw new Error(`capability pack ${args.pkg.name} has no check '${request.checkId}'`);
  }
  return await check.run(request.cwd, request.options);
}

async function createHostContributions(
  context: Parameters<CapabilityIsolationBridge['createHostContributions']>[0],
): Promise<readonly CapabilityBridgeContribution[]> {
  const result = (await context.invoke({
    kind: 'fitness.discover',
  } satisfies FitnessDiscoverRequest)) as FitnessDiscoverResult;
  return [
    ...result.checks.map((descriptor) => ({
      contribution: createProxyCheck(descriptor.config, context.invoke),
    })),
    ...result.coContributions,
  ];
}

/**
 * Dispatch a worker-side fit-pack request.
 *
 * @throws {Error} when the request kind is unknown.
 */
async function runInWorker(
  context: Parameters<CapabilityIsolationBridge['runInWorker']>[0],
): Promise<unknown> {
  const request = context.request as FitnessWorkerRequest;
  if (request.kind === 'fitness.discover') return await discoverWorkerContributions(context);
  if (request.kind === 'fitness.run') return await runWorkerCheck(context, request);
  throw new Error(`unknown fitness capability worker request`);
}

/** Worker-isolation bridge for external fit-pack contributions. */
export const isolatedFitPackBridge: CapabilityIsolationBridge = {
  createHostContributions,
  runInWorker,
};
