/**
 * Graph-owned complete catalog input verification.
 *
 * The verifier reruns only selection, discovery, and cache-input assembly. It
 * never parses, walks, evaluates rules, or writes persistence.
 */

import { isAbsolute, relative, resolve, sep } from 'node:path';

import {
  currentScope,
  isPathInside,
  err,
  ok,
  type Result,
  type LanguageAdapter,
} from '@opensip-cli/core';

import { stampEngineVersion } from '../cache/engine-version.js';
import { computeFilesFingerprint, parseFilesFingerprint } from '../cache/invalidate.js';
import {
  buildShardedCatalogCacheKey,
  isSafeShardedCacheAnchor,
} from '../cache/sharded-cache-key.js';
import { resolveCanonicalFileSet } from '../cli/orchestrate/canonical-file-set.js';
import {
  resolveDefaultEngineShards,
  type EngineShardPolicyResolution,
} from '../cli/orchestrate/engine-shard-policy.js';
import { compareCodePointStrings } from '../code-point-order.js';
import { isSafeGraphAdapterDescriptor } from '../lang-adapter/descriptor-validation.js';
import { GraphAdapterSelector } from '../lang-adapter/selector.js';

import { failGraphRead } from './read-boundary-failure.js';

import type {
  FreshnessChangeSummary,
  FreshnessReasonCode,
  FreshnessVerification,
} from './query-contracts.js';
import type { GraphAdapterRegistryReader, GraphReadError, GraphReadReason } from './types.js';
import type { DiscoverOutput, GraphLanguageAdapter } from '../lang-adapter/types.js';
import type {
  AdapterSelectionEvidence,
  Catalog,
  CatalogShardCacheInput,
  GraphConfig,
} from '../types.js';

/** Registered replacement for the un-catalogued `GRAPH.READ.VERIFY_FAILED` reason code. */

const MAX_ADAPTERS = 64;
const MAX_DISCOVERED_FILES = 1_000_000;
const MAX_CACHE_KEY_LEN = 1024;
const MAX_CHANGE_SAMPLES = 50;
const MAX_DISCOVERY_PATH_LEN = 4096;
const MAX_SHARD_INPUTS = 10_000;
const MAX_SHARD_ID_LEN = 256;
const VERIFY_CACHE_KEY_ERROR = 'verify-cache-key';
const VERIFY_DISCOVERY_ERROR = 'verify-discovery';

/** Inputs used to verify that a persisted catalog still matches current graph inputs. */
export interface VerifyCatalogInputsInput {
  readonly projectRoot: string;
  readonly catalog: Catalog;
  readonly adapters: GraphAdapterRegistryReader;
  readonly languageAdapters: readonly LanguageAdapter[];
  readonly graphConfig?: GraphConfig;
}

function graphReadError(code: GraphReadReason, message: string): GraphReadError {
  const bounded = message.length > 160 ? `${message.slice(0, 157)}...` : message;
  return { code, operation: 'catalog-generation', message: bounded };
}

function nowIso(): string {
  return new Date().toISOString();
}

function partial(reasonCode: FreshnessReasonCode, reason: string): FreshnessVerification {
  return {
    fresh: false,
    verifiedAt: nowIso(),
    verification: 'partial',
    reasonCode,
    reason,
  };
}

function complete(
  fresh: boolean,
  reasonCode?: FreshnessReasonCode,
  reason?: string,
  changes?: FreshnessChangeSummary,
): FreshnessVerification {
  return {
    fresh,
    verifiedAt: nowIso(),
    verification: 'complete',
    ...(reasonCode === undefined ? {} : { reasonCode }),
    ...(reason === undefined ? {} : { reason }),
    ...(changes === undefined ? {} : { changes }),
  };
}

/** Validate a complete adapter descriptor before selection or discovery. */
export function isSafeAdapterDescriptor(adapter: GraphLanguageAdapter): boolean {
  return isSafeGraphAdapterDescriptor(adapter);
}

function snapshotRegistry(
  source: GraphAdapterRegistryReader,
): Result<GraphAdapterRegistryReader, GraphReadError> {
  const entries = source.getAll();
  if (entries.length > MAX_ADAPTERS || source.size !== entries.length) {
    return err(graphReadError('verify-registry', 'Adapter registry snapshot is inconsistent'));
  }
  const map = new Map<string, GraphLanguageAdapter>();
  for (const entry of entries) {
    if (
      entry.id !== entry.adapter.id ||
      map.has(entry.id) ||
      !isSafeGraphAdapterDescriptor(entry.adapter)
    ) {
      return err(
        graphReadError(
          'verify-descriptor',
          'Adapter registry contains a hostile or inconsistent descriptor',
        ),
      );
    }
    map.set(entry.id, entry.adapter);
  }
  const snapshotEntries = [...map].map(([id, adapter]) => ({ id, adapter }));
  return ok({
    size: snapshotEntries.length,
    getAll: () => snapshotEntries,
    getById: (id) => {
      const adapter = map.get(id);
      return adapter === undefined ? undefined : { adapter };
    },
  });
}

/**
 * Verify that a served catalog still matches complete current discovery inputs.
 * Legacy metadata remains queryable but is never represented as verified fresh.
 */
export async function verifyCatalogInputs(
  input: VerifyCatalogInputsInput,
): Promise<Result<FreshnessVerification, GraphReadError>> {
  try {
    const registry = snapshotRegistry(input.adapters);
    if (!registry.ok) return registry;

    const selection = input.catalog.adapterSelection;
    const engineMode = input.catalog.engineMode;
    if (selection === undefined || engineMode === undefined) {
      return ok(
        partial(
          'verification-unavailable',
          'Catalog lacks adapter-selection or engine-mode provenance',
        ),
      );
    }
    if (engineMode === 'sharded' && input.catalog.shardCacheInputs === undefined) {
      return ok(
        partial(
          'verification-unavailable',
          'Sharded catalog lacks producing cache-input provenance',
        ),
      );
    }
    const selected = selectAdapter(registry.value, selection, input.projectRoot);
    if (!selected.ok) return selected;
    if (selected.value.id !== selection.selectedId) {
      return ok(
        complete(false, 'selection-changed', 'Active adapter selection no longer matches catalog'),
      );
    }
    if (selected.value.id !== input.catalog.language) {
      return ok(
        complete(false, 'language-changed', 'Catalog language no longer matches selection'),
      );
    }
    const stampedEngineMode = engineModeFromCacheKey(input.catalog.cacheKey);
    if (stampedEngineMode === undefined) {
      return ok(
        partial('verification-unavailable', 'Catalog cache key lacks engine-mode provenance'),
      );
    }
    const engine = await verifyEnginePolicy(
      input,
      selected.value,
      selection,
      engineMode,
      stampedEngineMode,
    );
    if (!engine.ok) return engine;
    if (engine.value.verdict !== undefined) return ok(engine.value.verdict);

    const currentInputs = await recomputeCatalogInputs({
      adapter: selected.value,
      catalog: input.catalog,
      projectRoot: input.projectRoot,
      currentShards: engine.value.policy.shards,
    });
    if (!currentInputs.ok) return currentInputs;
    if (currentInputs.value.cacheKey !== input.catalog.cacheKey) {
      return ok(complete(false, 'cache-key-changed', 'Catalog cache inputs changed'));
    }

    const currentFingerprint = computeFilesFingerprint(currentInputs.value.files);
    if (currentFingerprint === input.catalog.filesFingerprint) {
      return ok(complete(true));
    }
    const changes = changeSummary(
      input.catalog.filesFingerprint ?? '',
      currentFingerprint,
      input.projectRoot,
    );
    return ok(
      complete(false, 'files-changed', 'Source files changed since catalog build', changes),
    );
  } catch (error) {
    return failGraphRead(error, {
      boundary: 'infrastructure',
      condition: 'catalog-verification',
      module: 'graph:read:catalog-freshness',
      reason: 'catalog-unreadable',
      operation: 'catalog-generation',
      message: 'Catalog input verification failed due to infrastructure error',
    });
  }
}

interface VerifiedEnginePolicy {
  readonly policy: EngineShardPolicyResolution;
  readonly verdict?: FreshnessVerification;
}

async function verifyEnginePolicy(
  input: VerifyCatalogInputsInput,
  adapter: GraphLanguageAdapter,
  selection: AdapterSelectionEvidence,
  engineMode: 'exact' | 'sharded',
  stampedEngineMode: 'exact' | 'sharded',
): Promise<Result<VerifiedEnginePolicy, GraphReadError>> {
  const exactPolicy: EngineShardPolicyResolution = { shards: [] };
  if (stampedEngineMode !== engineMode) {
    return ok({
      policy: exactPolicy,
      verdict: complete(
        false,
        'engine-mode-changed',
        'Catalog engine mode no longer matches cache inputs',
      ),
    });
  }
  // Exact may have been selected explicitly in a shardable repository. The
  // payload does not persist that CLI choice, so verify its exact inputs rather
  // than falsely comparing it with today's default sharding policy.
  if (engineMode === 'exact') return ok({ policy: exactPolicy });

  const policy = await resolveDefaultEngineShards({
    projectRoot: input.projectRoot,
    languageAdapters: input.languageAdapters,
    graphAdapter: adapter,
    graphConfig: input.graphConfig ?? {},
    forcedLanguage: selection.mode === 'forced',
    failureMode: 'verification-error',
  });
  if (policy.shards.length <= 1) {
    return ok({
      policy,
      verdict: complete(
        false,
        'engine-mode-changed',
        'Catalog engine mode no longer matches cache inputs',
      ),
    });
  }
  const expectedShards = shardAnchorsForPolicy(policy.shards, input.projectRoot);
  if (!expectedShards.ok) return expectedShards;
  return sameShardAnchors(expectedShards.value, input.catalog.shardCacheInputs ?? [])
    ? ok({ policy })
    : ok({
        policy,
        verdict: complete(
          false,
          'cache-key-changed',
          'Active shard plan no longer matches catalog',
        ),
      });
}

function shardAnchorsForPolicy(
  shards: readonly {
    readonly id: string;
    readonly rootDir: string;
    readonly configPathAbs?: string;
  }[],
  projectRoot: string,
): Result<readonly CatalogShardCacheInput[], GraphReadError> {
  const anchors: CatalogShardCacheInput[] = [];
  for (const shard of shards) {
    const rootDir = projectRelativeAnchor(shard.rootDir, projectRoot);
    if (rootDir === undefined) {
      return err(
        graphReadError(VERIFY_DISCOVERY_ERROR, 'Shard root escaped the configured project'),
      );
    }
    const configPath =
      shard.configPathAbs === undefined
        ? undefined
        : projectRelativeAnchor(shard.configPathAbs, projectRoot);
    if (shard.configPathAbs !== undefined && configPath === undefined) {
      return err(
        graphReadError(VERIFY_DISCOVERY_ERROR, 'Shard config escaped the configured project'),
      );
    }
    anchors.push({
      shardId: shard.id,
      rootDir,
      ...(configPath === undefined ? {} : { configPath }),
    });
  }
  anchors.sort((a, b) => compareCodePointStrings(a.shardId, b.shardId));
  return ok(anchors);
}

function projectRelativeAnchor(path: string, projectRoot: string): string | undefined {
  if (!isSafeAbsolutePath(path) || !isPathInside(path, projectRoot)) return undefined;
  const value = relative(resolve(projectRoot), resolve(path));
  if (isAbsolute(value) || value === '..' || value.startsWith(`..${sep}`)) return undefined;
  return (value || '.').split(sep).join('/');
}

function sameShardAnchors(
  expected: readonly CatalogShardCacheInput[],
  persisted: readonly CatalogShardCacheInput[],
): boolean {
  const normalized = [...persisted].sort((a, b) => compareCodePointStrings(a.shardId, b.shardId));
  return JSON.stringify(expected) === JSON.stringify(normalized);
}

function engineModeFromCacheKey(cacheKey: string): 'exact' | 'sharded' | undefined {
  const match = /(?:^|\|)mode=(exact|sharded)\|/.exec(cacheKey);
  const value = match?.[1];
  return value === 'exact' || value === 'sharded' ? value : undefined;
}

function selectAdapter(
  adapters: GraphAdapterRegistryReader,
  selection: AdapterSelectionEvidence,
  projectRoot: string,
): Result<GraphLanguageAdapter, GraphReadError> {
  try {
    const selector = new GraphAdapterSelector(adapters);
    return ok(
      selection.mode === 'forced'
        ? selector.pick({ cwd: projectRoot, language: selection.requestedId })
        : selector.pick({ cwd: projectRoot }),
    );
  } catch (error) {
    return failGraphRead(error, {
      boundary: 'infrastructure',
      condition: 'adapter-selection',
      module: 'graph:read:catalog-freshness',
      reason: 'verify-selection',
      operation: 'catalog-generation',
      message: 'Adapter selection failed during catalog verification',
    });
  }
}

interface RecomputeCacheKeyInput {
  readonly adapter: GraphLanguageAdapter;
  readonly catalog: Catalog;
  readonly projectRoot: string;
  readonly currentShards: readonly {
    readonly id: string;
    readonly files: readonly string[];
  }[];
}

interface CurrentCatalogInputs {
  readonly cacheKey: string;
  readonly files: readonly string[];
}

async function recomputeCatalogInputs(
  input: RecomputeCacheKeyInput,
): Promise<Result<CurrentCatalogInputs, GraphReadError>> {
  if (input.catalog.engineMode === 'sharded') {
    return recomputeShardedInputs(input);
  }
  const discovery = await input.adapter.discoverFiles({
    cwd: input.projectRoot,
    diagnosticIntent: 'quiet',
    signal: currentScope()?.abortSignal,
  });
  const discoveryCheck = validateDiscovery(discovery, input.projectRoot);
  if (!discoveryCheck.ok) return discoveryCheck;
  const raw = await input.adapter.cacheKey({
    projectDirAbs: discovery.projectDirAbs,
    configPathAbs: discovery.configPathAbs,
    compilerOptions: discovery.compilerOptions,
    resolutionMode: input.catalog.resolutionMode ?? 'exact',
    signal: currentScope()?.abortSignal,
  });
  const validated = validateRawCacheKey(raw);
  return validated.ok
    ? ok({
        cacheKey: stampEngineVersion(validated.value, 'exact'),
        files: resolveCanonicalFileSet(discovery.files),
      })
    : validated;
}

async function recomputeShardedInputs(
  input: RecomputeCacheKeyInput,
): Promise<Result<CurrentCatalogInputs, GraphReadError>> {
  const shardInputs = input.catalog.shardCacheInputs ?? [];
  if (shardInputs.length === 0 || shardInputs.length > MAX_SHARD_INPUTS) {
    return err(graphReadError(VERIFY_CACHE_KEY_ERROR, 'Sharded cache-input set is malformed'));
  }
  const seen = new Set<string>();
  const currentById = new Map(input.currentShards.map((shard) => [shard.id, shard]));
  const keys: {
    shardId: string;
    rootDir: string;
    configPath?: string;
    cacheKey: string;
  }[] = [];
  const files: string[] = [];
  for (const shard of shardInputs) {
    const anchor = resolveShardAnchor(shard, input.projectRoot, seen);
    if (!anchor.ok) return anchor;
    const currentShard = currentById.get(shard.shardId);
    if (currentShard === undefined) {
      return err(graphReadError(VERIFY_CACHE_KEY_ERROR, 'Current shard plan is incomplete'));
    }
    const discovery = await input.adapter.discoverFiles({
      cwd: anchor.value.rootDir,
      diagnosticIntent: 'quiet',
      ...(anchor.value.configPath === undefined
        ? {}
        : { configPathOverride: anchor.value.configPath }),
      signal: currentScope()?.abortSignal,
    });
    const discoveryCheck = validateDiscovery(discovery, input.projectRoot);
    if (!discoveryCheck.ok) return discoveryCheck;
    files.push(...currentShard.files);
    const raw = await input.adapter.cacheKey({
      projectDirAbs: anchor.value.rootDir,
      configPathAbs: anchor.value.configPath ?? discovery.configPathAbs,
      resolutionMode: input.catalog.resolutionMode ?? 'exact',
      signal: currentScope()?.abortSignal,
    });
    const validated = validateRawCacheKey(raw);
    if (!validated.ok) return validated;
    keys.push({
      shardId: shard.shardId,
      rootDir: shard.rootDir,
      ...(shard.configPath === undefined ? {} : { configPath: shard.configPath }),
      cacheKey: stampEngineVersion(validated.value, 'sharded'),
    });
  }
  return ok({
    cacheKey: buildShardedCatalogCacheKey(keys),
    files: resolveCanonicalFileSet(files),
  });
}

function resolveShardAnchor(
  shard: CatalogShardCacheInput,
  projectRoot: string,
  seen: Set<string>,
): Result<{ readonly rootDir: string; readonly configPath?: string }, GraphReadError> {
  if (
    !isSafeBoundedText(shard.shardId, MAX_SHARD_ID_LEN) ||
    seen.has(shard.shardId) ||
    !isSafeShardedCacheAnchor(shard.rootDir, MAX_DISCOVERY_PATH_LEN) ||
    (shard.configPath !== undefined &&
      !isSafeShardedCacheAnchor(shard.configPath, MAX_DISCOVERY_PATH_LEN))
  ) {
    return err(graphReadError(VERIFY_CACHE_KEY_ERROR, 'Sharded cache-input anchor is malformed'));
  }
  seen.add(shard.shardId);
  const rootDir = shard.rootDir === '.' ? projectRoot : resolve(projectRoot, shard.rootDir);
  let configPath: string | undefined;
  if (shard.configPath === '.') configPath = projectRoot;
  else if (shard.configPath !== undefined) configPath = resolve(projectRoot, shard.configPath);
  if (!isPathInside(rootDir, projectRoot)) {
    return err(
      graphReadError(VERIFY_CACHE_KEY_ERROR, 'Sharded root escaped the configured project'),
    );
  }
  if (configPath !== undefined && !isPathInside(configPath, projectRoot)) {
    return err(
      graphReadError(VERIFY_CACHE_KEY_ERROR, 'Sharded config escaped the configured project'),
    );
  }
  return ok({ rootDir, ...(configPath === undefined ? {} : { configPath }) });
}

function validateRawCacheKey(value: unknown): Result<string, GraphReadError> {
  return typeof value === 'string' && isSafeBoundedText(value, MAX_CACHE_KEY_LEN)
    ? ok(value)
    : err(graphReadError(VERIFY_CACHE_KEY_ERROR, 'Adapter cacheKey is malformed or oversized'));
}

function validateDiscovery(
  discovery: DiscoverOutput,
  projectRoot: string,
): Result<void, GraphReadError> {
  if (discovery.files.length > MAX_DISCOVERED_FILES) {
    return err(graphReadError(VERIFY_DISCOVERY_ERROR, 'Discovery returned too many files'));
  }
  if (
    !isSafeAbsolutePath(discovery.projectDirAbs) ||
    !isPathInside(discovery.projectDirAbs, projectRoot)
  ) {
    return err(
      graphReadError(
        VERIFY_DISCOVERY_ERROR,
        'Discovery project root escaped the configured project',
      ),
    );
  }
  if (
    discovery.configPathAbs !== undefined &&
    (!isSafeAbsolutePath(discovery.configPathAbs) ||
      !isPathInside(discovery.configPathAbs, projectRoot))
  ) {
    return err(
      graphReadError(
        VERIFY_DISCOVERY_ERROR,
        'Discovery config path escaped the configured project',
      ),
    );
  }

  let previous: string | undefined;
  for (const file of discovery.files) {
    if (!isSafeAbsolutePath(file) || !isPathInside(file, projectRoot)) {
      return err(
        graphReadError(
          VERIFY_DISCOVERY_ERROR,
          'Discovery returned a malformed or escaping file path',
        ),
      );
    }
    if (previous !== undefined && file <= previous) {
      return err(
        graphReadError(VERIFY_DISCOVERY_ERROR, 'Discovery files must be sorted and deduplicated'),
      );
    }
    previous = file;
  }
  return ok(undefined);
}

function isSafeAbsolutePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_DISCOVERY_PATH_LEN &&
    isAbsolute(value) &&
    !hasControlChar(value)
  );
}

function isSafeBoundedText(value: string, max: number): boolean {
  return value.length > 0 && value.length <= max && !hasControlChar(value);
}

function hasControlChar(value: string): boolean {
  return /\p{Cc}/u.test(value);
}

function changeSummary(
  previousFingerprint: string,
  currentFingerprint: string,
  projectRoot: string,
): FreshnessChangeSummary {
  const previous = parseFilesFingerprint(previousFingerprint);
  const current = parseFilesFingerprint(currentFingerprint);
  const changed: { path: string; kind: 'added' | 'modified' | 'deleted' }[] = [];
  for (const [path, mark] of current) {
    const previousMark = previous.get(path);
    if (previousMark === undefined) changed.push({ path, kind: 'added' });
    else if (previousMark !== mark) changed.push({ path, kind: 'modified' });
  }
  for (const path of previous.keys()) {
    if (!current.has(path)) changed.push({ path, kind: 'deleted' });
  }
  changed.sort(
    (a, b) => compareCodePointStrings(a.path, b.path) || compareCodePointStrings(a.kind, b.kind),
  );
  return {
    added: changed.filter((entry) => entry.kind === 'added').length,
    modified: changed.filter((entry) => entry.kind === 'modified').length,
    deleted: changed.filter((entry) => entry.kind === 'deleted').length,
    sample: changed
      .map((entry) => projectRelativeSample(entry.path, projectRoot))
      .filter((value): value is string => value !== undefined)
      .slice(0, MAX_CHANGE_SAMPLES),
  };
}

function projectRelativeSample(filePath: string, projectRoot: string): string | undefined {
  const root = resolve(projectRoot);
  const absolute = resolve(filePath);
  const value = relative(root, absolute);
  if (value.length === 0 || isAbsolute(value) || value === '..' || value.startsWith(`..${sep}`)) {
    return undefined;
  }
  return value.split(sep).join('/');
}

export { type FreshnessVerification } from './query-contracts.js';
export { type CatalogEngineMode } from '../types.js';
