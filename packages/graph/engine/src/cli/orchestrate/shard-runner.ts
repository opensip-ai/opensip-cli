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

import { correlationToEnv, currentScope, currentTraceparent, logger } from '@opensip-cli/core';

import { stampEngineVersion } from '../../cache/engine-version.js';
import { computeFilesFingerprint } from '../../cache/invalidate.js';

import { runWorkerPool } from './worker-pool.js';

import type { Shard, ShardBuildResult, ShardWorkerSpec } from './shard-model.js';
import type { GraphLanguageAdapter } from '../../lang-adapter/types.js';
import type { CatalogRepo } from '../../persistence/catalog-repo.js';
import type { ResolutionMode } from '../../types.js';
import type { DiagnosticLevel, DiagnosticsBus, RunCorrelation } from '@opensip-cli/core';

/**
 * The machine-filterable failure taxonomy for a shard worker, stamped on the
 * parent's `graph.shard.runner.shard_failed` event (subprocess-correlation
 * telemetry spec, Failure taxonomy). Every value is LIVE — `timeout` became
 * emittable with the hard kill-timeout below (M3); there is no dead enum value.
 *
 *   - `spawn`         — the child process failed to spawn (`child.on('error')`).
 *   - `exit_nonzero`  — the child spawned but exited with a non-zero code.
 *   - `stdout_parse`  — the child exited 0 but its stdout was not valid JSON.
 *   - `timeout`       — the hard kill-timeout fired and SIGKILLed a hung child.
 *   - `ipc_error`     — reserved for the fork (live-engine) transport (Phase 2).
 */
export type FailureClass = 'spawn' | 'exit_nonzero' | 'stdout_parse' | 'timeout' | 'ipc_error';

/**
 * A fixed, conservative wall-clock floor (10 minutes) after which a hung shard
 * worker is SIGKILLed so it is DIAGNOSABLE (`failureClass: 'timeout'`) instead
 * of stalling `runWorkerPool` — and therefore the whole build — forever. Before
 * this, `spawnShardWorker` only reacted to `close`/`error`/parse failure, so a
 * child stuck on a deadlocked parse never settled its `await run(item)`.
 *
 * This is deliberately a single named constant, NOT yet user-configurable: the
 * tunable retry/backoff/per-shard-budget policy is a separate resilience spec
 * (spec Q3/M3). Keeping it a constant lets that spec make it configurable later
 * without re-discovering the call site.
 */
const SHARD_HARD_KILL_TIMEOUT_MS = 10 * 60_000;

/**
 * Project a (possibly absent) parent {@link RunCorrelation} onto the flat set of
 * structured-log fields every `graph.shard.runner.*` event stamps. Centralized
 * so `start`, `shard_failed`, and `complete` stamp IDENTICALLY and `traceId` is
 * present on all three whenever OTel is on (GAP d). Absent optionals are omitted
 * (no empty sentinels).
 *
 * `traceId` is derived LIVE here (Task 3.3 / GAP d): the runner runs INSIDE the
 * sharded-build span (`buildShardedGraph`'s `withSpanAsync`), a child of the
 * bootstrap-time context the assembled `c.traceId` captured. Preferring the live
 * `currentTraceparent()` makes every runner event carry the SAME traceparent the
 * merge stage and worker-spawn sites derive (which already read it live) — so the
 * value cannot drift between events. Falls back to the bootstrap-stamped
 * `c.traceId`, then omitted when OTel is off (no active recording span).
 */
function correlationLogFields(c: RunCorrelation | undefined): Record<string, string> {
  if (!c) return {};
  const fields: Record<string, string> = {
    runId: c.runId,
    tool: c.tool,
    parentCommand: c.parentCommand,
  };
  const traceId = currentTraceparent() ?? c.traceId;
  if (traceId !== undefined) fields.traceId = traceId;
  if (c.repo !== undefined) fields.repo = c.repo;
  if (c.repoId !== undefined) fields.repoId = c.repoId;
  if (c.tenantId !== undefined) fields.tenantId = c.tenantId;
  return fields;
}

/**
 * Project the parent {@link RunCorrelation} onto the subset stamped on the
 * `subprocess.*` diagnostics milestones, with the LIVE `traceId` (Task 3.3 /
 * GAP d) so the snapshot's events pivot to the same trace as the JSONL events
 * (which derive it live via {@link correlationLogFields}). Returns `undefined`
 * when no parent correlation was assembled (tests / bare runs) so the milestones
 * are omitted, matching `correlationLogFields` returning `{}`.
 */
function diagnosticsMilestoneCorrelation(
  c: RunCorrelation | undefined,
): RunCorrelation | undefined {
  if (c === undefined) return undefined;
  const traceId = currentTraceparent();
  return { ...c, ...(traceId === undefined ? {} : { traceId }) };
}

/**
 * Synchronously emit one `subprocess.spawn|complete|failed` milestone on the
 * scope-owned diagnostics bus (ADR-0024, Phase 3) — a `void`, fire-and-forget
 * sync call; a no-op when the bus or the parent correlation is absent. Collapses
 * the bus-lookup + correlation-presence guard to a single call so the runner's
 * hot path stays flat.
 */
function emitShardMilestone(
  diagnostics: DiagnosticsBus | undefined,
  correlation: RunCorrelation | undefined,
  level: DiagnosticLevel,
  message: string,
  data: Record<string, unknown>,
): void {
  if (diagnostics === undefined || correlation === undefined) return;
  diagnostics.emitSubprocessEvent('load', level, message, correlation, data);
}

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
  /**
   * Hard wall-clock kill-timeout (ms) after which a hung shard worker is
   * SIGKILLed with `failureClass: 'timeout'` (M3). Defaults to
   * {@link SHARD_HARD_KILL_TIMEOUT_MS} (10 min) — the conservative production
   * floor. Exposed as an input ONLY so the timeout path is deterministically
   * exercisable in tests with a short value (the resilience spec, Q3/M3, will
   * later make it user-configurable); production never sets it.
   */
  readonly hardKillTimeoutMs?: number;
}

/** A shard whose worker failed — attributable, non-fatal. */
export interface ShardFailure {
  readonly shardId: string;
  readonly exitCode: number;
  /**
   * The FULL captured stderr — drives the user-facing message and stays
   * UNTRUNCATED here (M4). The parent's structured `shard_failed` event caps a
   * separate `stderrPreview` (~500c) independently, so a long stderr is never
   * lost from the failure surface.
   */
  readonly stderr: string;
  /** Machine-filterable failure taxonomy ({@link FailureClass}); absent on a clean exit. */
  readonly failureClass?: FailureClass;
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
  // The parent's correlation bag (assembled at the bootstrap composition root,
  // Phase 0) — stamped identically on all three runner events so an operator can
  // pivot from any one to the run/trace.
  const correlation = currentScope()?.correlation;
  const correlationFields = correlationLogFields(correlation);
  // The scope-owned diagnostics bus (ADR-0024): the JSONL logs above are for
  // `jq` grep; these milestones ride `CommandOutcome.diagnostics.events` for the
  // structured `--json` snapshot (Phase 3). Both surfaces are required. The
  // milestone correlation carries the LIVE `traceId` (Task 3.3 / GAP d) so the
  // snapshot's events pivot to the same trace as the JSONL events.
  const diagnostics = currentScope()?.diagnostics;
  const diagnosticsCorrelation = diagnosticsMilestoneCorrelation(correlation);
  logger.info({
    evt: 'graph.shard.runner.start',
    module: 'graph:shard-runner',
    ...correlationFields,
    shards: input.shards.length,
    concurrency,
  });
  // `subprocess.spawn` milestone — the pool is starting N shard workers.
  emitShardMilestone(diagnostics, diagnosticsCorrelation, 'debug', 'subprocess.spawn', {
    shards: input.shards.length,
    concurrency,
  });

  const hardKillTimeoutMs = input.hardKillTimeoutMs ?? SHARD_HARD_KILL_TIMEOUT_MS;
  const outcomes = await runWorkerPool(input.shards, concurrency, (shard) =>
    spawnShardWorker(
      shard,
      input.projectRoot,
      input.cliScript,
      input.resolutionMode,
      input.language,
      hardKillTimeoutMs,
    ),
  );

  const fragments: ShardBuildResult[] = [];
  const failures: ShardFailure[] = [];
  for (const o of outcomes) {
    if (o.result) fragments.push(o.result);
    else
      failures.push({
        shardId: o.shardId,
        exitCode: o.exitCode,
        stderr: o.stderr,
        ...(o.failureClass ? { failureClass: o.failureClass } : {}),
      });
  }
  // Deterministic order regardless of completion order.
  fragments.sort((a, b) => Number(a.shardId > b.shardId) - Number(a.shardId < b.shardId));
  failures.sort((a, b) => Number(a.shardId > b.shardId) - Number(a.shardId < b.shardId));

  // One structured per-shard event per failure (the runner is the emitter, not
  // the merge stage). `stderrPreview` is a SEPARATE ~500c cap for the structured
  // log; the full `failure.stderr` stays untouched on the returned ShardFailure
  // (M4) so the user-facing message keeps the complete output.
  for (const failure of failures) {
    logger.error({
      evt: 'graph.shard.runner.shard_failed',
      module: 'graph:shard-runner',
      ...correlationFields,
      shardId: failure.shardId,
      exitCode: failure.exitCode,
      ...(failure.failureClass ? { failureClass: failure.failureClass } : {}),
      stderrPreview: failure.stderr.slice(0, 500),
    });
    // `subprocess.failed` milestone — one per failed shard, keyed by `shardId`
    // so a `--json` consumer can filter `events` down to a single shard.
    emitShardMilestone(diagnostics, diagnosticsCorrelation, 'warn', 'subprocess.failed', {
      shardId: failure.shardId,
      exitCode: failure.exitCode,
      ...(failure.failureClass ? { failureClass: failure.failureClass } : {}),
    });
  }

  logger.info({
    evt: 'graph.shard.runner.complete',
    module: 'graph:shard-runner',
    ...correlationFields,
    built: fragments.length,
    failed: failures.length,
    failedShardIds: failures.map((f) => f.shardId),
  });
  // `subprocess.complete` milestone — the pool drained; carries the same
  // built/failed/failedShardIds summary as the structured log line.
  emitShardMilestone(diagnostics, diagnosticsCorrelation, 'debug', 'subprocess.complete', {
    built: fragments.length,
    failed: failures.length,
    failedShardIds: failures.map((f) => f.shardId),
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
  readonly failureClass?: FailureClass;
}

/**
 * Strip the env-only `runId` off a correlation bag for the spec JSON: per B1,
 * `runId` travels via `OPENSIP_RUN_ID` env ONLY and is `Omit`ed from
 * `ShardWorkerSpec.correlation`. Everything else (tool/parentCommand/traceId/…)
 * is carried in the spec so the worker can stamp it on spans/logs.
 */
function stripRunId({ runId: _runId, ...rest }: RunCorrelation): Omit<RunCorrelation, 'runId'> {
  return rest;
}

function spawnShardWorker(
  shard: Shard,
  projectRoot: string,
  cliScript: string,
  resolutionMode: ResolutionMode,
  language?: string,
  hardKillTimeoutMs: number = SHARD_HARD_KILL_TIMEOUT_MS,
): Promise<ShardOutcome> {
  return new Promise((resolvePromise) => {
    const specDir = mkdtempSync(join(tmpdir(), 'graph-shard-'));
    const specPath = join(specDir, 'spec.json');

    // Build this shard's correlation from the parent run's bag (Phase 0,
    // composition root) + this shard's id + workerKind. Absent when no scope
    // correlation was assembled (tests / bare runs) — the spec then omits the
    // `correlation` field and the worker degrades observably (M2).
    const baseCorrelation = currentScope()?.correlation;
    const correlation: RunCorrelation | undefined = baseCorrelation
      ? { ...baseCorrelation, shardId: shard.id, workerKind: 'shard' as const }
      : undefined;

    const spec: ShardWorkerSpec = {
      shard,
      projectRoot,
      resolutionMode,
      ...(language ? { language } : {}),
      // `runId` is env-only (B1) — stripped from the spec; the rest is carried so
      // the worker stamps tool/parentCommand/traceId/shardId on its spans/logs.
      ...(correlation ? { correlation: stripRunId(correlation) } : {}),
    };
    writeFileSync(specPath, JSON.stringify(spec), 'utf8');

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
    // only — never logged. Correlation env (`OPENSIP_*`, incl. OPENSIP_RUN_ID so
    // the child inherits the parent run, B1) is spread LAST; the `{ ...process.env }`
    // base already preserves PATH/HOME/OTEL_*, and `correlationToEnv` only adds
    // `OPENSIP_*` keys (and NEVER the API key, M1), so it can never clobber them (M2).
    const child = spawn(process.execPath, [cliScript, 'graph-shard-worker', specPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...(traceparent ? { TRACEPARENT: traceparent } : {}),
        ...(correlation ? correlationToEnv(correlation) : {}),
      },
    });

    // Arm the hard kill-timeout (M3): a hung child is SIGKILLed after a fixed
    // wall-clock floor so `runWorkerPool` settles (with failureClass 'timeout')
    // instead of hanging forever. `unref()` so a pending timer never keeps the
    // event loop alive past a clean settle; `cleanup` clears it on EVERY path.
    let timedOut = false;
    const killTimer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, hardKillTimeoutMs);
    killTimer.unref?.();
    const cleanup = (): void => {
      clearTimeout(killTimer);
      rmSync(specDir, { recursive: true, force: true });
    };

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
      resolvePromise({
        shardId: shard.id,
        exitCode: -1,
        stderr: `spawn failed: ${err.message}`,
        failureClass: 'spawn',
      });
      /* v8 ignore stop */
    });
    child.on('close', (code) => {
      cleanup();
      if (timedOut) {
        resolvePromise({
          shardId: shard.id,
          exitCode: code ?? -1,
          stderr:
            stderr +
            `\ngraph shard worker killed after ${String(hardKillTimeoutMs)}ms hard kill-timeout`,
          failureClass: 'timeout',
        });
        return;
      }
      if (code !== 0) {
        resolvePromise({
          shardId: shard.id,
          exitCode: code ?? -1,
          stderr,
          failureClass: 'exit_nonzero',
        });
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
          failureClass: 'stdout_parse',
        });
        /* v8 ignore stop */
      }
    });
  });
}
