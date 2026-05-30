/**
 * `graph-shard-worker <specPath>` — the per-shard build subprocess.
 *
 * One worker process builds ONE shard: it reads a {@link ShardWorkerSpec}
 * JSON file, runs parse → walk → resolve over the shard's explicit file
 * set (requesting cross-boundary descriptors), and writes a serializable
 * {@link ShardBuildResult} JSON to stdout. The parent (the shard runner)
 * spawns N of these under a concurrency cap and merges their fragments.
 *
 * This is an internal command, not a user-facing one — the shard runner
 * invokes `node <cliScript> graph-shard-worker <specPath>`. It exists as a
 * subcommand so the worker runs inside the bootstrapped CLI scope (the
 * language-adapter registry is populated), letting `pickAdapter` resolve
 * the adapter exactly as the main build does.
 *
 * The boundary is JSON only: no `ts.Node` / `ts.Program` ever crosses it.
 */

import { readFileSync } from 'node:fs';

import { logger } from '@opensip-tools/core';

import { computeFilesFingerprint } from '../cache/invalidate.js';
import { pickAdapter } from '../lang-adapter/registry.js';

import { buildAndResolveCatalog, type RunStage } from './orchestrate/catalog-builder.js';

import type { ShardBuildResult, ShardWorkerSpec } from './orchestrate/shard-model.js';
import type { DiscoverOutput } from '../lang-adapter/types.js';
import type { ToolCliContext } from '@opensip-tools/core';

/** A progress-less runStage: the worker has no live view, so stages just run. */
const passthroughRunStage: RunStage = (_stage, _onProgress, _monitor, fn) => fn();

/**
 * Build one shard and emit its `ShardBuildResult` as JSON on stdout.
 * Exits non-zero (via setExitCode) on failure so the parent can attribute
 * the error to this shard.
 */
export function executeShardWorker(specPath: string, cli: ToolCliContext): void {
  let shardId = '<unknown>';
  try {
    const spec = JSON.parse(readFileSync(specPath, 'utf8')) as ShardWorkerSpec;
    shardId = spec.shard.id;
    const result = buildShard(spec);
    // Single write of the whole JSON document — the parent reads stdout to EOF.
    process.stdout.write(JSON.stringify(result));
    cli.setExitCode(0);
  } catch (error) {
    logger.error({
      evt: 'graph.shard.worker.error',
      module: 'graph:shard-worker',
      shardId,
      err: error instanceof Error ? error.message : String(error),
    });
    process.stderr.write(
      `graph-shard-worker [${shardId}]: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    cli.setExitCode(1);
  }
}

function buildShard(spec: ShardWorkerSpec): ShardBuildResult {
  const { shard, projectRoot, resolutionMode } = spec;
  const adapter = pickAdapter(shard.rootDir);

  // Anchor compiler options to the shard's own config, but compute
  // occurrence filePaths against the COMMON project root so fragments
  // align across shards when merged.
  const discovered = adapter.discoverFiles({
    cwd: shard.rootDir,
    configPathOverride: shard.configPathAbs,
  });
  const discovery: DiscoverOutput = {
    projectDirAbs: projectRoot,
    files: shard.files,
    configPathAbs: shard.configPathAbs ?? discovered.configPathAbs,
    compilerOptions: discovered.compilerOptions,
  };

  const built = buildAndResolveCatalog(
    passthroughRunStage,
    adapter,
    discovery,
    resolutionMode,
    undefined,
    undefined,
    /* emitBoundaryCalls */ true,
  );

  return {
    shardId: shard.id,
    fragment: built.catalog,
    fingerprint: computeFilesFingerprint(shard.files),
    boundaryCalls: built.boundaryCalls ?? [],
    parseErrors: built.parseErrors,
  };
}
