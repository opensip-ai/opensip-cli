// @fitness-ignore-file no-direct-stdout-in-tool-engine -- subprocess IPC protocol: the worker serializes its ShardBuildResult to stdout and the parent (shard runner) reads stdout to EOF. This is not run output through the render seam; it is the wire format between two CLI processes.
// @fitness-ignore-file only-documented-toolcli-seams -- same rationale as above: this stdout write is the worker↔parent IPC wire, not user-facing run output through a ToolCliContext seam.
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

import {
  correlationFromEnv,
  currentScope,
  currentTraceparent,
  logger,
  REPO_OTEL_ATTR,
  TENANT_OTEL_ATTR,
} from '@opensip-cli/core';

import { computeFilesFingerprint } from '../cache/invalidate.js';
import { pickAdapter } from '../lang-adapter/registry.js';

import { spanRunStage } from './graph-tracer.js';
import { buildAndResolveCatalog } from './orchestrate/catalog-builder.js';

import type { ShardBuildResult, ShardWorkerSpec } from './orchestrate/shard-model.js';
import type { DiscoverOutput } from '../lang-adapter/types.js';
import type { Attributes, RunCorrelation, ToolCliContext } from '@opensip-cli/core';

/**
 * The flat structured-log fields stamped on every `graph.shard.worker.*` event:
 * the full correlation bag (incl. `runId`/`traceId`) so an operator can pivot
 * from any worker line to the parent run and its trace. Absent optionals are
 * omitted (no empty sentinels).
 */
function workerLogFields(c: RunCorrelation): Record<string, string> {
  const fields: Record<string, string> = {
    runId: c.runId,
    tool: c.tool,
    parentCommand: c.parentCommand,
  };
  if (c.traceId !== undefined) fields.traceId = c.traceId;
  if (c.repo !== undefined) fields.repo = c.repo;
  if (c.repoId !== undefined) fields.repoId = c.repoId;
  if (c.tenantId !== undefined) fields.tenantId = c.tenantId;
  if (c.shardId !== undefined) fields.shardId = c.shardId;
  return fields;
}

/**
 * Resolve the worker's correlation bag for stamping on spans + logs.
 *
 * `runId` comes from `currentScope()?.runId` — already inherited from
 * `OPENSIP_RUN_ID` at the worker's pre-action hook (B1), the env-first read.
 * The remaining fields (`tool`/`parentCommand`/`traceId`/`repo`/…) come from the
 * spec's `correlation` (Task 1.2 wrote them, sans runId); `shardId` is anchored
 * to this shard; `traceId` falls back to the live `currentTraceparent()` so the
 * worker's own trace context is captured even if the spec omitted it.
 *
 * Missing-correlation degradation (M2): when BOTH the spec's `correlation` and
 * `correlationFromEnv()` are absent the worker still runs (with the
 * fresh/inherited `runId`) but emits a `cli.subprocess.correlation_missing`
 * WARN so the gap is observable, not silent.
 */
function resolveWorkerCorrelation(spec: ShardWorkerSpec): RunCorrelation {
  const runId = currentScope()?.runId ?? '';
  const fromEnv = correlationFromEnv();
  if (spec.correlation === undefined && fromEnv === undefined) {
    logger.warn({
      evt: 'cli.subprocess.correlation_missing',
      module: 'graph:shard-worker',
      runId,
      workerKind: 'shard',
      reason: 'no correlation env or spec',
    });
  }
  return {
    runId,
    tool: spec.correlation?.tool ?? fromEnv?.tool ?? '',
    parentCommand: spec.correlation?.parentCommand ?? fromEnv?.parentCommand ?? '',
    workerKind: 'shard',
    shardId: spec.shard.id,
    ...spec.correlation,
    // traceId: prefer the spec/env value, else the worker's live trace context.
    traceId: spec.correlation?.traceId ?? fromEnv?.traceId ?? currentTraceparent(),
  };
}

/**
 * Build the OTel span base attrs for a shard worker — the shard id plus the
 * correlation join keys, referencing the single attr-name source ({@link
 * REPO_OTEL_ATTR}/{@link TENANT_OTEL_ATTR}, Q4). Undefined values are OMITTED so
 * no span carries an empty attribute.
 */
function shardSpanAttrs(corr: RunCorrelation): Attributes {
  const attrs: Attributes = { 'opensip_cli.graph.shard_id': corr.shardId ?? '' };
  if (corr.runId) attrs['opensip.run_id'] = corr.runId;
  if (corr.parentCommand) attrs['opensip.parent_command'] = corr.parentCommand;
  if (corr.repo !== undefined) attrs[REPO_OTEL_ATTR] = corr.repo;
  if (corr.tenantId !== undefined) attrs[TENANT_OTEL_ATTR] = corr.tenantId;
  return attrs;
}

/**
 * Build one shard and emit its `ShardBuildResult` as JSON on stdout.
 * Exits non-zero (via setExitCode) on failure so the parent can attribute
 * the error to this shard.
 */
export async function executeShardWorker(specPath: string, cli: ToolCliContext): Promise<void> {
  let shardId = '<unknown>';
  // The full correlation for failure logging. Resolved lazily once the spec
  // parses; until then a bare bag carries the env-inherited runId (B1) so even a
  // spec-parse failure logs an attributable line.
  let correlation: RunCorrelation = {
    runId: currentScope()?.runId ?? '',
    tool: correlationFromEnv()?.tool ?? '',
    parentCommand: correlationFromEnv()?.parentCommand ?? '',
    workerKind: 'shard',
  };
  // Worker-internal diagnostic timing — tool-owned (NOT a generic StoredSession
  // column; host-owned-run-timing). Drives `durationMs` on `worker.complete`.
  const startedAt = Date.now();
  try {
    const spec = JSON.parse(readFileSync(specPath, 'utf8')) as ShardWorkerSpec;
    shardId = spec.shard.id;
    correlation = resolveWorkerCorrelation(spec);
    logger.info({
      evt: 'graph.shard.worker.start',
      module: 'graph:shard-worker',
      ...workerLogFields(correlation),
    });
    const result = await buildShard(spec, correlation);
    // Single write of the whole JSON document — the parent reads stdout to EOF.
    process.stdout.write(JSON.stringify(result));
    logger.info({
      evt: 'graph.shard.worker.complete',
      module: 'graph:shard-worker',
      ...workerLogFields(correlation),
      durationMs: Date.now() - startedAt,
    });
    cli.setExitCode(0);
  } catch (error) {
    logger.error({
      evt: 'graph.shard.worker.error',
      module: 'graph:shard-worker',
      ...workerLogFields(correlation),
      shardId,
      err: error instanceof Error ? error.message : String(error),
      // The child's own view of the failure class. The parent re-derives this
      // from the exit/parse channel for the runner event; this is the worker's
      // local attribution — a build throw is a non-zero exit from the parent's
      // perspective.
      failureClass: 'exit_nonzero',
    });
    process.stderr.write(
      `graph-shard-worker [${shardId}]: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    cli.setExitCode(1);
  }
}

async function buildShard(
  spec: ShardWorkerSpec,
  correlation: RunCorrelation,
): Promise<ShardBuildResult> {
  const { shard, projectRoot, resolutionMode } = spec;
  const adapter = pickAdapter(shard.rootDir, spec.language);

  // Anchor compiler options to the shard's own config, but compute
  // occurrence filePaths against the COMMON project root so fragments
  // align across shards when merged. For the synthetic `:root` shard,
  // `shard.configPathAbs` is the ROOT tsconfig — so root scripts and other
  // files under no package tsconfig parse/resolve against the root compiler
  // options (Phase 1). The discovery here is consulted ONLY for those compiler
  // options: the file set is `shard.files` (the canonical partition the runner
  // pre-enumerated), NOT the tsconfig's own include/exclude glob — so test
  // files now assigned to a package shard parse even though that package's
  // tsconfig would have excluded them (tsc compiles `rootNames` verbatim).
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

  // Emit per-stage spans tagged with this shard's id AND the correlation join
  // keys (run id, parent command, repo/tenant via the single attr-name source —
  // Q4) so a sharded-build trace is attributable to its parent run. They nest
  // under the parent build's sharded span via the TRACEPARENT the runner
  // propagates into this worker's env (extracted at the CLI boundary by
  // initTelemetry). No live view here — the worker is headless — so no
  // progress/monitor plumbing.
  const built = await buildAndResolveCatalog({
    runStage: spanRunStage(shardSpanAttrs(correlation)),
    adapter,
    discovery,
    resolutionMode,
    emitBoundaryCalls: true,
    // Stamp this fragment's cacheKey with `mode=sharded` so it matches what
    // `planShardWork` compares against (loadValidShardFragment) and never
    // collides with a single-program (exact) catalog row.
    engineMode: 'sharded',
  });

  return {
    shardId: shard.id,
    fragment: built.catalog,
    fingerprint: computeFilesFingerprint(shard.files),
    boundaryCalls: built.boundaryCalls ?? [],
    parseErrors: built.parseErrors,
  };
}
