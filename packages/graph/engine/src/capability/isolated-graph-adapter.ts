import {
  coreErrorCatalog,
  importCapabilityPackageModule,
  isToolErrorLike,
  PluginIncompatibleError,
  type CapabilityBridgeContribution,
  type CapabilityIsolationBridge,
} from '@opensip-cli/core';

import { graphAdapterSignal, throwIfGraphAdapterAborted } from '../lang-adapter/cancellation.js';
import {
  isSafeGraphAdapterDescriptor,
  isSafeGraphAdapterMetadata,
} from '../lang-adapter/descriptor-validation.js';

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

const CONTRIBUTION_SCHEMA_MISMATCH = coreErrorCatalog.require('CORE.CONTRIBUTION.SCHEMA_MISMATCH');
const REQUIRED_PACK_LOAD_FAILED = coreErrorCatalog.require(
  'CORE.PLUGINS.REQUIRED_PACK_LOAD_FAILED',
);

function incompatibleContribution(
  message: string,
  condition: string,
  exportName?: string,
  cause?: unknown,
): PluginIncompatibleError {
  return new PluginIncompatibleError(message, {
    code: CONTRIBUTION_SCHEMA_MISMATCH.code,
    definition: CONTRIBUTION_SCHEMA_MISMATCH,
    ...(cause === undefined ? {} : { cause }),
    metadata: {
      condition,
      ...(exportName === undefined ? {} : { exportName }),
    },
  });
}

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
  return isSafeGraphAdapterDescriptor(value);
}

/**
 * Load and validate the graph adapter export from an isolated package.
 *
 * @throws {PluginIncompatibleError} when the package cannot load or its export is not an adapter.
 */
async function loadAdapter(
  args: Parameters<CapabilityIsolationBridge['runInWorker']>[0],
): Promise<GraphLanguageAdapter> {
  let mod: Record<string, unknown>;
  try {
    mod = await importCapabilityPackageModule(args.pkg);
  } catch (error) {
    // A normalizing boundary must never downgrade an already-defined failure (ruling D6).
    if (isToolErrorLike(error)) throw error;
    throw new PluginIncompatibleError(`capability package '${args.pkg.name}' could not be loaded`, {
      code: REQUIRED_PACK_LOAD_FAILED.code,
      definition: REQUIRED_PACK_LOAD_FAILED,
      cause: error,
      metadata: {
        condition: 'graph-adapter-load',
        packageName: args.pkg.name,
      },
    });
  }
  const value = mod[args.descriptor.exportName];
  if (!isGraphAdapter(value)) {
    throw incompatibleContribution(
      `capability pack export '${args.descriptor.exportName}' must be a graph adapter`,
      'graph-adapter-export',
      args.descriptor.exportName,
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
      await invokeAdapter<DiscoverOutput>('graph.discoverFiles', input, invoke, 'discovery'),
    parseProject: async (input: ParseInput): Promise<ParseOutput<unknown>> =>
      await invokeAdapter<ParseOutput<unknown>>('graph.parseProject', input, invoke, 'parse'),
    walkProject: async (input: WalkInput<unknown>): Promise<WalkOutput> =>
      await invokeAdapter<WalkOutput>('graph.walkProject', input, invoke, 'walk'),
    resolveCallSites: async (input: ResolveInput<unknown>): Promise<ResolveOutput> =>
      await invokeAdapter<ResolveOutput>('graph.resolveCallSites', input, invoke, 'resolution'),
    cacheKey: async (input: CacheKeyInput): Promise<string> =>
      await invokeAdapter<string>('graph.cacheKey', input, invoke, 'cache-key computation'),
  };
}

type AdapterInvocationInput =
  DiscoverInput | ParseInput | WalkInput<unknown> | ResolveInput<unknown> | CacheKeyInput;

/** Invoke an isolated adapter without attempting to structured-clone AbortSignal. */
async function invokeAdapter<T>(
  kind: GraphInvokeRequest['kind'],
  input: AdapterInvocationInput,
  invoke: (request: unknown) => Promise<unknown>,
  stage: string,
): Promise<T> {
  const signal = graphAdapterSignal(input.signal);
  // Synchronous checkpoint inside an async boundary; there is no promise to detach.
  void throwIfGraphAdapterAborted(signal, stage);
  const { signal: omittedSignal, ...wireInput } = input;
  void omittedSignal;
  const operation = invoke({ kind, input: wireInput } satisfies GraphInvokeRequest) as Promise<T>;
  if (signal === undefined) return await operation;
  return await settleWithAbort(operation, signal, stage);
}

function settleWithAbort<T>(operation: Promise<T>, signal: AbortSignal, stage: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cleanup = (): void => signal.removeEventListener('abort', onAbort);
    const onAbort = (): void => {
      cleanup();
      try {
        throwIfGraphAdapterAborted(signal, stage);
      } catch (error) {
        // The checkpoint only throws registered ErrorDefinition-backed errors.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        reject(error);
      }
    };
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        // Preserve the worker supervisor's typed rejection without downgrading it.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        reject(error);
      },
    );
    if (signal.aborted) onAbort();
  });
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
    signal: input.signal,
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
    signal: input.signal,
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
 * @throws {PluginIncompatibleError} when the request kind is unknown.
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
  throw incompatibleContribution('unknown graph capability worker request', 'worker-request');
}

/**
 * Create the host-side proxy contribution from worker-reported adapter metadata.
 *
 * @throws {PluginIncompatibleError} when the worker returns an unsafe adapter descriptor.
 */
async function createHostContributions(
  context: Parameters<CapabilityIsolationBridge['createHostContributions']>[0],
): Promise<readonly CapabilityBridgeContribution[]> {
  const result = (await context.invoke({
    kind: 'graph.discover',
  } satisfies GraphDiscoverRequest)) as GraphDiscoverResult;
  if (!isSafeGraphAdapterMetadata(result.adapter)) {
    throw incompatibleContribution(
      'capability pack returned an unsafe graph adapter descriptor',
      'worker-descriptor',
      context.descriptor.exportName,
    );
  }
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
