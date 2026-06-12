/**
 * Shard runner — drives N shard workers in parallel and collects their
 * serializable `ShardBuildResult` fragments.
 *
 * Each shard is built in its own child process (`graph-shard-worker`), so
 * heap is isolated per shard: N shards × per-shard budget ≈ total budget,
 * the same memory-scaling property the legacy `--workspace` runner has.
 * Concurrency is capped at `cpus()-1` by default. A worker that exits
 * non-zero is surfaced as a `ShardFailure` attributable to its shard id
 * rather than aborting the whole build.
 *
 * The spec is handed to the worker via a temp FILE (not argv) because a
 * shard can enumerate thousands of files, well past the OS argv limit.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { join } from 'node:path';

import { currentTraceparent, logger } from '@opensip-cli/core';

import { stampEngineVersion } from '../../cache/engine-version.js';
import { computeFilesFingerprint } from '../../cache/invalidate.js';

import { runWorkerPool } from './worker-pool.js';

import type { Shard, ShardBuildResult, ShardWorkerSpec } from './shard-model.js';
import type { GraphLanguageAdapter } from '../../lang-adapter/types.js';
import type { CatalogRepo } from '../../persistence/catalog-repo.js';
import type { ResolutionMode } from '../../types.js';

export interface RunShardsInput {
  readonly shards: readonly Shard[];
  /** Common project root — every fragment's filePaths resolve against it. */
  readonly projectRoot: string;
  /** CLI entry script (`process.argv[1]`); children run `node <cliScript> graph-shard-worker <spec>`. */
  readonly cliScript: string;
  /** Optional adapter id requested by the parent `graph --language <id>` run. */
  readonly language?: string;
  readonly resolutionMode: ResolutionMode;
  /** Concurrency cap. Default: `max(1, cpus()-1)`. */
  readonly concurrency?: number;
}

/** A shard whose worker exited non-zero — attributable, non-fatal. */
export interface ShardFailure {
  readonly shardId: string;
  readonly exitCode: number;
  readonly stderr: string;
}

export interface RunShardsOutput {
  readonly fragments: readonly ShardBuildResult[];
  readonly failures: readonly ShardFailure[];
}

/**
 * Build every shard in a bounded parallel pool. Always resolves; per-shard
 * failures are collected in `failures` (never thrown) so one bad shard
 * doesn't sink the build.
 */
export async function runShardsInParallel(input: RunShardsInput): Promise<RunShardsOutput> {
  const concurrency = Math.max(1, input.concurrency ?? Math.max(1, cpus().length - 1));
  logger.info({
    evt: 'graph.shard.runner.start',
    module: 'graph:shard-runner',
    shards: input.shards.length,
    concurrency,
  });

  const outcomes = await runWorkerPool(input.shards, concurrency, (shard) =>
    spawnShardWorker(
      shard,
      input.projectRoot,
      input.cliScript,
      input.resolutionMode,
      input.language,
    ),
  );

  const fragments: ShardBuildResult[] = [];
  const failures: ShardFailure[] = [];
  for (const o of outcomes) {
    if (o.result) fragments.push(o.result);
    else failures.push({ shardId: o.shardId, exitCode: o.exitCode, stderr: o.stderr });
  }
  // Deterministic order regardless of completion order.
  fragments.sort((a, b) => a.shardId.localeCompare(b.shardId));
  failures.sort((a, b) => a.shardId.localeCompare(b.shardId));

  logger.info({
    evt: 'graph.shard.runner.complete',
    module: 'graph:shard-runner',
    built: fragments.length,
    failed: failures.length,
  });
  return { fragments, failures };
}

/** Partition of a build's shards into reusable-from-cache vs needs-rebuild. */
export interface ShardWorkPlan {
  /** Fragments loaded verbatim from the per-shard cache — no worker runs. */
  readonly cached: readonly ShardBuildResult[];
  /** Shards whose files (or config/mode) changed — a worker must rebuild them. */
  readonly toBuild: readonly Shard[];
}

/**
 * Decide, per shard, whether its cached fragment is still valid (config
 * key + files fingerprint match) and can be reused without a worker, or
 * whether the shard must be rebuilt. This is the incremental-parse fix:
 * unchanged shards skip parse entirely. With `useCache=false` (or no
 * repo) every shard is rebuilt.
 *
 * Cheap by design — it stats each shard's files (fingerprint) and reads
 * each shard's config (cacheKey); no parsing, no worker spawn.
 */
export function planShardWork(
  shards: readonly Shard[],
  repo: CatalogRepo | null,
  adapter: GraphLanguageAdapter,
  resolutionMode: ResolutionMode,
  useCache: boolean,
): ShardWorkPlan {
  if (!useCache || !repo) return { cached: [], toBuild: [...shards] };
  const cached: ShardBuildResult[] = [];
  const toBuild: Shard[] = [];
  for (const shard of shards) {
    const cacheKey = stampEngineVersion(
      adapter.cacheKey({
        projectDirAbs: shard.rootDir,
        configPathAbs: shard.configPathAbs,
        resolutionMode,
      }),
      // Shard fragments only ever feed the sharded engine; stamp the mode so a
      // fragment row can never be confused with a single-program (exact) build.
      'sharded',
    );
    const fingerprint = computeFilesFingerprint(shard.files);
    const fragment = repo.loadValidShardFragment(shard.id, cacheKey, fingerprint);
    if (fragment) cached.push(fragment);
    else toBuild.push(shard);
  }
  logger.info({
    evt: 'graph.shard.plan',
    module: 'graph:shard-runner',
    reused: cached.length,
    rebuild: toBuild.length,
  });
  return { cached, toBuild };
}

interface ShardOutcome {
  readonly shardId: string;
  readonly result?: ShardBuildResult;
  readonly exitCode: number;
  readonly stderr: string;
}

function spawnShardWorker(
  shard: Shard,
  projectRoot: string,
  cliScript: string,
  resolutionMode: ResolutionMode,
  language?: string,
): Promise<ShardOutcome> {
  return new Promise((resolvePromise) => {
    const specDir = mkdtempSync(join(tmpdir(), 'graph-shard-'));
    const specPath = join(specDir, 'spec.json');
    const spec: ShardWorkerSpec = {
      shard,
      projectRoot,
      resolutionMode,
      ...(language ? { language } : {}),
    };
    writeFileSync(specPath, JSON.stringify(spec), 'utf8');

    const cleanup = (): void => rmSync(specDir, { recursive: true, force: true });
    // Propagate the active trace context (the parent's sharded-build span) to
    // the worker as TRACEPARENT, so the worker's per-stage spans nest under our
    // build trace instead of forming orphan traces. `currentTraceparent()` is
    // undefined for standalone runs (no SDK), so TRACEPARENT is simply absent
    // and the worker emits no spans, exactly as before.
    const traceparent = currentTraceparent();
    // Inherit the PARENT's cwd (the opensip-cli project dir) so the
    // child's CLI bootstrap resolves the project + adapter registry. The
    // shard's own files are built from `shard.rootDir` in the spec, not from
    // cwd — so the shard need not be a project itself. The full parent env is
    // forwarded (the child needs PATH/HOME/OTEL_* etc.) into spawn's env option
    // only — never logged.
    const child = spawn(process.execPath, [cliScript, 'graph-shard-worker', specPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...(traceparent ? { TRACEPARENT: traceparent } : {}),
      },
    });
    let stdout = '';
    let stderr = '';
    // setEncoding routes chunks through a StringDecoder that buffers
    // partial multi-byte UTF-8 sequences across 'data' chunk boundaries.
    // Without it, a non-ASCII char split across two chunks (likely for
    // large fragments arriving in many chunks) decodes to replacement
    // chars and corrupts the JSON parsed in the close handler.
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c: string) => {
      stdout += c;
    });
    child.stderr.on('data', (c: string) => {
      stderr += c;
    });
    child.on('error', (err) => {
      /* v8 ignore start */
      cleanup();
      resolvePromise({ shardId: shard.id, exitCode: -1, stderr: `spawn failed: ${err.message}` });
      /* v8 ignore stop */
    });
    child.on('close', (code) => {
      cleanup();
      if (code !== 0) {
        resolvePromise({ shardId: shard.id, exitCode: code ?? -1, stderr });
        return;
      }
      try {
        const result = JSON.parse(stdout) as ShardBuildResult;
        resolvePromise({ shardId: shard.id, result, exitCode: 0, stderr });
      } catch (error) {
        /* v8 ignore start */
        resolvePromise({
          shardId: shard.id,
          exitCode: 1,
          stderr: `unparseable worker output: ${error instanceof Error ? error.message : String(error)}`,
        });
        /* v8 ignore stop */
      }
    });
  });
}
