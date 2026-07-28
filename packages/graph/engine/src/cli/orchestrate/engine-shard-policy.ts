import {
  currentLogger,
  currentScope,
  isToolErrorLike,
  type LanguageAdapter,
} from '@opensip-cli/core';

import { graphBuildError } from '../../errors/graph-build-error.js';
import { discoverPolyglotUnits } from '../workspace-runner.js';

import { resolveCanonicalFileSet } from './canonical-file-set.js';
import {
  detectMonorepoLayout,
  partitionFlatRepo,
  selectStrategyForLayout,
} from './flat-monorepo-strategy.js';
import { partitionFilesIntoShards } from './partition-files.js';

import type { Shard } from './shard-model.js';
import type { GraphLanguageAdapter } from '../../lang-adapter/types.js';
import type { GraphConfig, PartitionStrategy } from '../../types.js';

export interface EngineShardPolicyResolution {
  readonly shards: Shard[];
  readonly partition?: { readonly durationMs: number; readonly detail: string };
}

export interface DefaultEngineShardPolicyInput {
  readonly projectRoot: string;
  readonly languageAdapters: readonly LanguageAdapter[];
  readonly graphAdapter: GraphLanguageAdapter;
  readonly graphConfig: GraphConfig;
  readonly forcedLanguage: boolean;
  /** Producer preserves historical exact fallback; verifier must fail closed. */
  readonly failureMode?: 'producer-fallback' | 'verification-error';
}

/**
 * Canonical default exact/sharded policy shared by the producer and freshness
 * verifier. It performs discovery/partition planning only; it never parses or
 * walks source files.
 */
export async function resolveDefaultEngineShards(
  input: DefaultEngineShardPolicyInput,
): Promise<EngineShardPolicyResolution> {
  const workspace = await resolveWorkspaceShards(input);
  if (workspace.length > 1) return { shards: workspace };
  return resolveSyntheticShards(input);
}

async function resolveWorkspaceShards(input: DefaultEngineShardPolicyInput): Promise<Shard[]> {
  let units: Awaited<ReturnType<typeof discoverPolyglotUnits>>;
  try {
    units = await discoverPolyglotUnits(input.projectRoot, input.languageAdapters);
  } catch (error) {
    if (isToolErrorLike(error)) throw error;
    return recoverShardPolicyFailure(input, [], 'workspace-discovery');
  }
  if (units.length <= 1) return [];
  try {
    const discovery = await input.graphAdapter.discoverFiles({
      cwd: input.projectRoot,
      diagnosticIntent: 'quiet',
      signal: currentScope()?.abortSignal,
    });
    return partitionFilesIntoShards({
      canonicalFiles: resolveCanonicalFileSet(discovery.files),
      units: units.map((unit) => ({
        id: unit.id,
        rootDir: unit.rootDir,
        ...(unit.configPath === undefined ? {} : { configPathAbs: unit.configPath }),
      })),
      projectRoot: discovery.projectDirAbs,
      rootConfigPathAbs: discovery.configPathAbs,
    });
  } catch (error) {
    if (isToolErrorLike(error)) throw error;
    return recoverShardPolicyFailure(input, [], 'workspace-file-discovery');
  }
}

async function resolveSyntheticShards(
  input: DefaultEngineShardPolicyInput,
): Promise<EngineShardPolicyResolution> {
  if (input.forcedLanguage || input.graphAdapter.id !== 'typescript') return { shards: [] };
  let discovery: Awaited<ReturnType<GraphLanguageAdapter['discoverFiles']>>;
  try {
    discovery = await input.graphAdapter.discoverFiles({
      cwd: input.projectRoot,
      diagnosticIntent: 'quiet',
      signal: currentScope()?.abortSignal,
    });
  } catch (error) {
    if (isToolErrorLike(error)) throw error;
    return recoverShardPolicyFailure(input, { shards: [] }, 'synthetic-file-discovery');
  }
  const canonicalFiles = resolveCanonicalFileSet(discovery.files);
  const partitionStart = Date.now();
  const layout = detectMonorepoLayout({
    repoRoot: discovery.projectDirAbs,
    files: canonicalFiles,
  });
  const selection = selectStrategyForLayout(layout);
  if (layout.kind !== 'flat-large' || selection.mode !== 'synthetic-partition') {
    return { shards: [] };
  }
  const strategy: PartitionStrategy =
    input.graphConfig.partitionStrategy ?? selection.partitionStrategy ?? 'hybrid';
  const shards = partitionFlatRepo({
    files: layout.files,
    repoRoot: discovery.projectDirAbs,
    strategy,
  })
    .filter((partition) => partition.files.length > 0)
    .map((partition): Shard => ({
      id: `partition:${partition.id}`,
      rootDir: discovery.projectDirAbs,
      files: partition.files,
      configPathAbs: discovery.configPathAbs,
    }));
  if (shards.length <= 1) return { shards: [] };
  return {
    shards,
    partition: {
      durationMs: Date.now() - partitionStart,
      detail: `${strategy}: ${String(shards.length)} partition(s)`,
    },
  };
}

/**
 * Preserve producer fallback while making verifier discovery failures explicit.
 *
 * @throws {Error} when shard discovery fails in strict verification mode.
 */
function throwWhenVerificationStrict(input: DefaultEngineShardPolicyInput): void {
  if (input.failureMode === 'verification-error') {
    throw graphBuildError(
      'shard-discovery-verification',
      'Graph engine-shard discovery failed during verification',
    );
  }
}

function recoverShardPolicyFailure<T>(
  input: DefaultEngineShardPolicyInput,
  fallback: T,
  phase: string,
): T {
  throwWhenVerificationStrict(input);
  currentLogger().warn({
    evt: 'graph.engine_shard_policy.fallback',
    module: 'graph:engine-shard-policy',
    phase,
    outcome: 'exact-fallback',
  });
  return fallback;
}
