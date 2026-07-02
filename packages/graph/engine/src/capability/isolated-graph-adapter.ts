import {
  importCapabilityPackageModule,
  type CapabilityBridgeContribution,
  type CapabilityIsolationBridge,
} from '@opensip-cli/core';

import type {
  CacheKeyInput,
  DiscoverInput,
  DiscoverOutput,
  GraphLanguageAdapter,
  ParseInput,
  ParseOutput,
  ResolveInput,
  ResolveOutput,
  WalkInput,
  WalkOutput,
} from '../lang-adapter/types.js';

interface GraphDiscoverRequest {
  readonly kind: 'graph.discover';
}

interface GraphInvokeRequest {
  readonly kind:
    | 'graph.discoverFiles'
    | 'graph.parseProject'
    | 'graph.walkProject'
    | 'graph.resolveCallSites'
    | 'graph.cacheKey';
  readonly input: unknown;
}

type GraphWorkerRequest = GraphDiscoverRequest | GraphInvokeRequest;

interface GraphDiscoverResult {
  readonly adapter: {
    readonly id: string;
    readonly fileExtensions: readonly string[];
    readonly displayName?: string;
    readonly ruleHints?: GraphLanguageAdapter['ruleHints'];
  };
}

interface GraphProjectHandle {
  readonly __opensipCapabilityGraphProject: true;
  readonly parseInput: ParseInput;
}

function isGraphAdapter(value: unknown): value is GraphLanguageAdapter {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === 'string' &&
    Array.isArray(record.fileExtensions) &&
    typeof record.discoverFiles === 'function' &&
    typeof record.parseProject === 'function' &&
    typeof record.walkProject === 'function' &&
    typeof record.resolveCallSites === 'function' &&
    typeof record.cacheKey === 'function'
  );
}

/**
 * Load and validate the graph adapter export from an isolated package.
 *
 * @throws {Error} when the export is missing or is not a graph adapter.
 */
async function loadAdapter(
  args: Parameters<CapabilityIsolationBridge['runInWorker']>[0],
): Promise<GraphLanguageAdapter> {
  const mod = await importCapabilityPackageModule({
    ...args.pkg,
    errorConstructor: Error,
  });
  const value = mod[args.descriptor.exportName];
  if (!isGraphAdapter(value)) {
    throw new Error(
      `capability pack export '${args.descriptor.exportName}' must be a graph adapter`,
    );
  }
  return value;
}

function projectHandle(parseInput: ParseInput): GraphProjectHandle {
  return { __opensipCapabilityGraphProject: true, parseInput };
}

function isProjectHandle(value: unknown): value is GraphProjectHandle {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { __opensipCapabilityGraphProject?: unknown }).__opensipCapabilityGraphProject ===
      true
  );
}

async function parseFromHandle(
  adapter: GraphLanguageAdapter,
  handle: GraphProjectHandle,
): Promise<ParseOutput<unknown>> {
  return await adapter.parseProject(handle.parseInput);
}

function createProxyAdapter(
  descriptor: GraphDiscoverResult['adapter'],
  invoke: (request: unknown) => Promise<unknown>,
): GraphLanguageAdapter<unknown> {
  return {
    ...descriptor,
    discoverFiles: async (input: DiscoverInput): Promise<DiscoverOutput> =>
      (await invoke({
        kind: 'graph.discoverFiles',
        input,
      } satisfies GraphInvokeRequest)) as DiscoverOutput,
    parseProject: async (input: ParseInput): Promise<ParseOutput<unknown>> =>
      (await invoke({
        kind: 'graph.parseProject',
        input,
      } satisfies GraphInvokeRequest)) as ParseOutput<unknown>,
    walkProject: async (input: WalkInput<unknown>): Promise<WalkOutput> =>
      (await invoke({
        kind: 'graph.walkProject',
        input,
      } satisfies GraphInvokeRequest)) as WalkOutput,
    resolveCallSites: async (input: ResolveInput<unknown>): Promise<ResolveOutput> =>
      (await invoke({
        kind: 'graph.resolveCallSites',
        input,
      } satisfies GraphInvokeRequest)) as ResolveOutput,
    cacheKey: async (input: CacheKeyInput): Promise<string> =>
      (await invoke({ kind: 'graph.cacheKey', input } satisfies GraphInvokeRequest)) as string,
  };
}

async function handleParseProject(
  adapter: GraphLanguageAdapter,
  input: ParseInput,
): Promise<ParseOutput<GraphProjectHandle>> {
  const parsed = await adapter.parseProject(input);
  return {
    project: projectHandle(input),
    parseErrors: parsed.parseErrors,
  };
}

async function handleWalkProject(
  adapter: GraphLanguageAdapter,
  input: WalkInput<unknown>,
): Promise<WalkOutput> {
  if (!isProjectHandle(input.project)) {
    return adapter.walkProject(input);
  }
  const parsed = await parseFromHandle(adapter, input.project);
  // @fitness-ignore-next-line async-waterfall-detection -- walkProject needs the parsed worker-local project object.
  const walked = await adapter.walkProject({
    project: parsed.project,
    projectDirAbs: input.projectDirAbs,
    files: input.files,
  });
  return {
    ...walked,
    callSites: [],
    dependencySites: [],
  };
}

async function handleResolveCallSites(
  adapter: GraphLanguageAdapter,
  input: ResolveInput<unknown>,
): Promise<ResolveOutput> {
  if (!isProjectHandle(input.project)) {
    return adapter.resolveCallSites(input);
  }
  const parsed = await parseFromHandle(adapter, input.project);
  // @fitness-ignore-next-line async-waterfall-detection -- resolving needs call sites from the worker-local walk.
  const walked = await adapter.walkProject({
    project: parsed.project,
    projectDirAbs: input.projectDirAbs,
    files: input.project.parseInput.files,
  });
  // @fitness-ignore-next-line async-waterfall-detection -- resolveCallSites needs the walked call/dependency sites.
  return await adapter.resolveCallSites({
    ...input,
    project: parsed.project,
    callSites: walked.callSites,
    ...(walked.dependencySites === undefined ? {} : { dependencySites: walked.dependencySites }),
  });
}

/**
 * Dispatch one worker-side graph-adapter request.
 *
 * @throws {Error} when the request kind is unknown.
 */
async function runGraphWorkerRequest(
  adapter: GraphLanguageAdapter,
  request: GraphWorkerRequest,
): Promise<unknown> {
  switch (request.kind) {
    case 'graph.discover': {
      return {
        adapter: {
          id: adapter.id,
          fileExtensions: adapter.fileExtensions,
          ...(adapter.displayName === undefined ? {} : { displayName: adapter.displayName }),
          ...(adapter.ruleHints === undefined ? {} : { ruleHints: adapter.ruleHints }),
        },
      } satisfies GraphDiscoverResult;
    }
    case 'graph.discoverFiles': {
      return await adapter.discoverFiles(request.input as DiscoverInput);
    }
    case 'graph.parseProject': {
      return await handleParseProject(adapter, request.input as ParseInput);
    }
    case 'graph.walkProject': {
      return await handleWalkProject(adapter, request.input as WalkInput<unknown>);
    }
    case 'graph.resolveCallSites': {
      return await handleResolveCallSites(adapter, request.input as ResolveInput<unknown>);
    }
    case 'graph.cacheKey': {
      return await adapter.cacheKey(request.input as CacheKeyInput);
    }
  }
  throw new Error('unknown graph capability worker request');
}

async function createHostContributions(
  context: Parameters<CapabilityIsolationBridge['createHostContributions']>[0],
): Promise<readonly CapabilityBridgeContribution[]> {
  const result = (await context.invoke({
    kind: 'graph.discover',
  } satisfies GraphDiscoverRequest)) as GraphDiscoverResult;
  return [{ contribution: createProxyAdapter(result.adapter, context.invoke) }];
}

async function runInWorker(
  context: Parameters<CapabilityIsolationBridge['runInWorker']>[0],
): Promise<unknown> {
  const adapter = await loadAdapter(context);
  const request = context.request as GraphWorkerRequest;
  return await runGraphWorkerRequest(adapter, request);
}

/** Worker-isolation bridge for external graph-adapter contributions. */
export const isolatedGraphAdapterBridge: CapabilityIsolationBridge = {
  createHostContributions,
  runInWorker,
};
