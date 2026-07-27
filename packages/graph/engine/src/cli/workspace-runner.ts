/**
 * `graph --workspace` parallel runner.
 *
 * Fans a graph run out across every workspace unit detected by the
 * language adapters' `discoverWorkspaceUnits` hook by spawning one
 * child process per unit, each running `graph <rootDir> --json`. Each
 * child has its own Node heap, so the per-unit memory ceiling that
 * Phase 6 already provides scales naturally:
 * N units × ~per-unit-budget ≈ total budget. Concurrency is capped at
 * `os.cpus().length - 1` (or a caller override) so we don't
 * oversubscribe.
 *
 * Polyglot per spec D8b: callers compose units from multiple adapters
 * via `discoverPolyglotUnits` and pass the flattened list. The runner
 * itself is language-agnostic — it only sees opaque `WorkspaceUnit`s.
 */

import { spawn } from 'node:child_process';
import { cpus } from 'node:os';
import { relative } from 'node:path';

import { EXIT_CODES, isSignalEnvelope, type SignalEnvelope } from '@opensip-cli/contracts';
import {
  createCancelledError,
  createToolLogger,
  ConfigurationError,
  currentScope,
  scrubText,
  type LanguageAdapter,
  type Signal,
  type WorkspaceUnit,
} from '@opensip-cli/core';

import { graphErrorCatalog } from '../errors/graph-error-catalog.js';

import { runWorkerPool } from './orchestrate/worker-pool.js';

import type { ResolutionMode } from '../types.js';

const log = createToolLogger('graph:cli');

/** Closed Result-reason vocabulary for workspace child failures (ruling D4). */
export type WorkspaceChildFailureReason = 'spawn-failed' | 'timeout' | 'output-malformed';

/** Bounded branch detail for a workspace child failure. */
export type WorkspaceChildFailureCondition =
  'spawn-error' | 'hard-kill-timeout' | 'empty-output' | 'invalid-json' | 'invalid-envelope';

type WorkspaceChildFailureClass = 'spawn' | 'timeout' | 'stdout_parse';

/**
 * Per-unit result from a `graph --workspace` fan-out — one entry per
 * child process spawned by `runWorkspaceUnitsInParallel`.
 */
export interface WorkspaceUnitRunResult {
  /** Human-readable unit id (e.g. `core`, `cli`, `crate-foo`). */
  readonly unitId: string;
  /** Absolute root dir the child was spawned against. */
  readonly rootDir: string;
  /**
   * Project-relative path for display. Empty string if `rootDir` isn't
   * under `cwd`.
   */
  readonly displayPath: string;
  /**
   * The child run's signals, parsed from its `--json` {@link SignalEnvelope}
   * stdout (ADR-0011). These carry OpenSIP-mapped `ruleId`/`source` (the
   * child applies Option A); the parent reverse-maps to engine slugs only
   * where the dashboard session payload needs them.
   */
  readonly signals: readonly Signal[];
  readonly exitCode: number;
  readonly stderr: string;
  /** Closed plain-data reason; the matching definition declares its publicPresentationKey. */
  readonly failureReason?: WorkspaceChildFailureReason;
  /** Registered code linked to {@link failureReason}; this remains a Result, not a thrown error. */
  readonly errorCode?: string;
  /** Existing worker-boundary taxonomy retained for operational filtering. */
  readonly failureClass?: WorkspaceChildFailureClass;
  /** Distinguishes branches clustered under one definition (ruling D9). */
  readonly failureCondition?: WorkspaceChildFailureCondition;
  /** Safe OS errno when process creation fails. */
  readonly errno?: string;
}

/**
 * Inputs to `runWorkspaceUnitsInParallel`. `units` is the flattened
 * polyglot list typically produced by `discoverPolyglotUnits`.
 */
export interface RunWorkspaceUnitsInput {
  readonly cwd: string;
  /** Exact OpenSIP config selected by the parent invocation, when present. */
  readonly configPath?: string;
  readonly units: readonly WorkspaceUnit[];
  /**
   * Path to the CLI entry script — typically `process.argv[1]` from
   * the parent. Children invoke `node <cliScript> graph <rootDir>
   * --json`.
   */
  readonly cliScript: string;
  /** Override concurrency for tests. Default: cpus()-1, min 1. */
  readonly concurrency?: number;
  /** Forwarded to children if true. */
  readonly noCache?: boolean;
  /**
   * Edge resolution tier. Forwarded to each child as `--resolution
   * <mode>` so a `--workspace --resolution fast` run is fast per unit,
   * not silently exact. Omitted/`'exact'` ⇒ children use their default.
   */
  readonly resolution?: ResolutionMode;
  /**
   * Optional adapter id. Forwarded to each child as `--language <id>` so
   * workspace fan-out preserves the parent's explicit adapter selection.
   */
  readonly language?: string;
  /**
   * `--recipe <name>`: forwarded to each child as `--recipe <name>` so a
   * `--workspace --recipe <name>` run selects the same rule subset per
   * unit. Children re-resolve the recipe in their own scope (resolved
   * `Rule` objects can't cross the process boundary). Omitted ⇒ children
   * use the default recipe.
   */
  readonly recipe?: string;
  /** Test override (ms) for the per-unit hard kill-timeout. */
  readonly hardKillTimeoutMs?: number;
}

/**
 * Aggregate output from `runWorkspaceUnitsInParallel` — per-unit
 * results plus a single boolean indicating whether any child failed.
 */
export interface RunWorkspaceUnitsOutput {
  readonly perUnit: readonly WorkspaceUnitRunResult[];
  readonly anyChildFailed: boolean;
}

/**
 * Aggregate WorkspaceUnits across all adapters that implement the
 * discovery hook. Per spec D8b: in a polyglot repo (e.g. TS frontend +
 * Cargo backend) both adapters contribute units to one combined fan-
 * out. Adapters without the hook contribute zero units (D5).
 *
 * Returns units sorted by `rootDir` for deterministic fan-out order.
 */
export async function discoverPolyglotUnits(
  rootDir: string,
  adapters: readonly LanguageAdapter[],
): Promise<readonly WorkspaceUnit[]> {
  const all: WorkspaceUnit[] = [];
  for (const adapter of adapters) {
    if (!adapter.discoverWorkspaceUnits) continue;
    const units = await adapter.discoverWorkspaceUnits(rootDir);
    all.push(...units);
  }
  all.sort((a, b) => a.rootDir.localeCompare(b.rootDir));
  return all;
}

/**
 * Spawn one child process per WorkspaceUnit, run `graph <rootDir>
 * --json` in each, and aggregate the parsed findings. Concurrency is
 * capped (default `cpus()-1`). Child-process failures are surfaced via
 * `anyChildFailed`; invalid empty input and host cancellation reject before
 * returning a partial aggregate.
 *
 * @throws {ConfigurationError} When no workspace units were supplied.
 * @throws {ToolError} When the host cancels the workspace run.
 */
export async function runWorkspaceUnitsInParallel(
  input: RunWorkspaceUnitsInput,
): Promise<RunWorkspaceUnitsOutput> {
  if (input.units.length === 0) {
    throw new ConfigurationError(
      '--workspace: no workspace units found. Use `opensip graph` for whole-project analysis.',
    );
  }

  const concurrency = Math.max(1, input.concurrency ?? Math.max(1, cpus().length - 1));
  const abortSignal = currentScope()?.abortSignal;
  if (abortRequested(abortSignal)) {
    throw createCancelledError('Graph workspace run cancelled before child scheduling.');
  }
  log.info({
    evt: 'graph.cli.workspace.start',
    module: 'graph:cli',
    units: input.units.length,
    concurrency,
  });

  // Shared bounded worker pool (also used by the shard runner). Each slot
  // spawns one child at a time and pulls the next unit when it finishes.
  const results = await runWorkerPool(
    input.units,
    concurrency,
    (unit) =>
      spawnGraphChild({
        cliScript: input.cliScript,
        unit,
        cwd: input.cwd,
        ...(input.configPath === undefined ? {} : { configPath: input.configPath }),
        noCache: input.noCache === true,
        resolution: input.resolution,
        recipe: input.recipe,
        abortSignal,
        ...(input.language === undefined ? {} : { language: input.language }),
        ...(input.hardKillTimeoutMs === undefined
          ? {}
          : { hardKillTimeoutMs: input.hardKillTimeoutMs }),
      }),
    () => abortRequested(abortSignal),
  );
  if (abortRequested(abortSignal)) {
    throw createCancelledError('Graph workspace run cancelled while children were running.');
  }
  const anyChildFailed = results.some((r) => r.exitCode !== 0);

  // Sort for deterministic display order regardless of completion
  // order — units finish in unpredictable order under parallelism.
  results.sort((a, b) => a.rootDir.localeCompare(b.rootDir));

  log.info({
    evt: 'graph.cli.workspace.complete',
    module: 'graph:cli',
    units: input.units.length,
    anyChildFailed,
  });

  return { perUnit: results, anyChildFailed };
}

function abortRequested(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/**
 * Wall-clock floor after which a hung workspace-unit child is SIGKILLed so the
 * pool drains instead of hanging forever. Matches shard-runner's default.
 */
const WORKSPACE_HARD_KILL_TIMEOUT_MS = 10 * 60_000;

interface SpawnInput {
  readonly cliScript: string;
  readonly unit: WorkspaceUnit;
  readonly cwd: string;
  readonly configPath?: string;
  readonly noCache: boolean;
  readonly resolution?: ResolutionMode;
  readonly language?: string;
  readonly recipe?: string;
  readonly abortSignal?: AbortSignal;
  /** Test override for the hard kill-timeout (default {@link WORKSPACE_HARD_KILL_TIMEOUT_MS}). */
  readonly hardKillTimeoutMs?: number;
}

function spawnGraphChild(input: SpawnInput): Promise<WorkspaceUnitRunResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const args: string[] = [
      input.cliScript,
      'graph',
      input.unit.rootDir,
      '--json',
      '--cwd',
      input.cwd,
    ];
    if (input.configPath !== undefined) args.push('--config', input.configPath);
    if (input.noCache) args.push('--no-cache');
    if (input.resolution !== undefined) args.push('--resolution', input.resolution);
    if (input.language !== undefined && input.language.length > 0)
      args.push('--language', input.language);
    if (input.recipe !== undefined) args.push('--recipe', input.recipe);

    const child = spawn(process.execPath, args, {
      cwd: input.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Mark the child as an internal workspace unit: its plain `--json` path
      // must NOT egress per unit or exit per verdict (the parent owns the
      // aggregate — audit P1-2). Read via readGraphEnv in renderGraphResult.
      // Multi-line spread mirrors heap-preflight.ts (the env object is passed to
      // spawn, never logged).
      env: {
        ...process.env,
        OPENSIP_GRAPH_WORKSPACE_CHILD: '1',
      },
    });
    // Arm the hard kill-timeout: a child stuck forever (deadlocked tree-sitter
    // parse, or blocked on the project write-lock under N-way contention) only
    // ever settles this promise via 'close'/'error', so without a wall-clock
    // floor its worker-pool slot — and thus the whole `--workspace` run — hangs
    // with no recovery. Mirrors shard-runner.ts. `unref()` so a pending timer
    // never keeps the loop alive past a clean settle; cleared on EVERY path.
    const hardKillMs = input.hardKillTimeoutMs ?? WORKSPACE_HARD_KILL_TIMEOUT_MS;
    let timedOut = false;
    let settled = false;
    const killTimer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, hardKillMs);
    killTimer.unref?.();

    let stdout = '';
    let stderr = '';
    // setEncoding routes chunks through a StringDecoder that buffers
    // partial multi-byte UTF-8 sequences across 'data' chunk boundaries.
    // Without it, a non-ASCII char split across two chunks decodes to
    // replacement chars and corrupts the --json stdout parsed below.
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    const cleanup = (): void => {
      clearTimeout(killTimer);
      input.abortSignal?.removeEventListener('abort', onAbort);
    };
    const settleResult = (result: WorkspaceUnitRunResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise(result);
    };
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      child.kill('SIGKILL');
      rejectPromise(createCancelledError('Graph workspace child cancelled by the host.'));
    };
    input.abortSignal?.addEventListener('abort', onAbort, { once: true });
    if (input.abortSignal?.aborted === true) onAbort();
    child.on('error', (err) => {
      /* v8 ignore start */
      const errno =
        typeof (err as NodeJS.ErrnoException).code === 'string'
          ? (err as NodeJS.ErrnoException).code
          : undefined;
      settleResult(
        workspaceChildFailure(input, 'spawn-failed', 'spawn-error', 'spawn', {
          stderr: scrubText(`Failed to spawn graph workspace child: ${err.message}`),
          ...(errno === undefined ? {} : { errno }),
        }),
      );
      /* v8 ignore stop */
    });
    child.on('close', (code) => {
      if (settled) return;
      if (timedOut) {
        settleResult(
          workspaceChildFailure(input, 'timeout', 'hard-kill-timeout', 'timeout', {
            stderr: failureStderr(
              `Graph workspace child exceeded its ${String(hardKillMs)}ms hard deadline.`,
              stderr,
            ),
          }),
        );
        return;
      }
      const exitCode = code ?? -1;
      if (exitCode !== EXIT_CODES.SUCCESS) {
        settleResult({
          unitId: input.unit.id,
          rootDir: input.unit.rootDir,
          displayPath: relative(input.cwd, input.unit.rootDir),
          signals: [],
          exitCode,
          stderr: scrubText(stderr),
        });
        return;
      }
      const parsed = parseChildSignals(stdout, input.unit.rootDir, stderr);
      if (!parsed.ok) {
        // @swallow-ok the Result error is converted into a typed workspace child failure.
        settleResult(
          workspaceChildFailure(input, 'output-malformed', parsed.condition, 'stdout_parse', {
            stderr: failureStderr(
              `Graph workspace child returned malformed output (${parsed.condition}).`,
              stderr,
            ),
          }),
        );
        return;
      }
      settleResult({
        unitId: input.unit.id,
        rootDir: input.unit.rootDir,
        displayPath: relative(input.cwd, input.unit.rootDir),
        signals: parsed.signals,
        exitCode,
        stderr: scrubText(stderr),
      });
    });
  });
}

const WORKSPACE_CHILD_FAILURE_DEFINITIONS = {
  'spawn-failed': graphErrorCatalog.require('GRAPH.WORKSPACE.CHILD_SPAWN_FAILED'),
  timeout: graphErrorCatalog.require('GRAPH.WORKSPACE.CHILD_TIMEOUT'),
  'output-malformed': graphErrorCatalog.require('GRAPH.WORKSPACE.CHILD_OUTPUT_MALFORMED'),
} as const;

interface WorkspaceFailureOptions {
  readonly stderr: string;
  readonly errno?: string;
}

function workspaceChildFailure(
  input: SpawnInput,
  reason: WorkspaceChildFailureReason,
  condition: WorkspaceChildFailureCondition,
  failureClass: WorkspaceChildFailureClass,
  options: WorkspaceFailureOptions,
): WorkspaceUnitRunResult {
  return {
    unitId: input.unit.id,
    rootDir: input.unit.rootDir,
    displayPath: relative(input.cwd, input.unit.rootDir),
    signals: [],
    exitCode: EXIT_CODES.RUNTIME_ERROR,
    stderr: options.stderr,
    failureReason: reason,
    errorCode: WORKSPACE_CHILD_FAILURE_DEFINITIONS[reason].code,
    failureClass,
    failureCondition: condition,
    ...(options.errno === undefined ? {} : { errno: options.errno }),
  };
}

function failureStderr(message: string, childStderr: string): string {
  const tail = scrubText(childStderr.trim(), 1000);
  return tail.length === 0 ? message : `${message}\n${tail}`;
}

type ChildSignalsParseResult =
  | { readonly ok: true; readonly signals: readonly Signal[] }
  | {
      readonly ok: false;
      readonly condition: Extract<
        WorkspaceChildFailureCondition,
        'empty-output' | 'invalid-json' | 'invalid-envelope'
      >;
    };

/**
 * Parse a child's `--json` {@link SignalEnvelope} stdout into a flat
 * `Signal[]` (ADR-0011 — `graph --json` now emits the envelope, not the
 * legacy `CliOutput`). Returns a closed failure condition when the child did
 * not produce a valid envelope; the caller faults that workspace unit.
 */
function parseChildSignals(
  stdout: string,
  rootDir: string,
  stderr: string,
): ChildSignalsParseResult {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    log.warn({
      evt: 'graph.cli.workspace.parse-error',
      module: 'graph:cli',
      rootDir,
      condition: 'empty-output',
      stderrLength: stderr.length,
    });
    return { ok: false, condition: 'empty-output' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch (error) {
    log.warn({
      evt: 'graph.cli.workspace.parse-error',
      module: 'graph:cli',
      rootDir,
      condition: 'invalid-json',
      err: scrubText(error instanceof Error ? error.message : String(error)),
      stderrLength: stderr.length,
    });
    return { ok: false, condition: 'invalid-json' };
  }
  const envelope = childSignalEnvelope(parsed);
  if (envelope === undefined) {
    log.warn({
      evt: 'graph.cli.workspace.parse-error',
      module: 'graph:cli',
      rootDir,
      condition: 'invalid-envelope',
      stderrLength: stderr.length,
    });
    return { ok: false, condition: 'invalid-envelope' };
  }
  return { ok: true, signals: envelope.signals };
}

/** Accept the current CommandOutcome carrier plus the former bare-envelope form. */
function childSignalEnvelope(value: unknown): SignalEnvelope | undefined {
  if (isSignalEnvelope(value)) return value;
  if (typeof value !== 'object' || value === null || !Object.hasOwn(value, 'envelope')) {
    return undefined;
  }
  const envelope = (value as { readonly envelope?: unknown }).envelope;
  return isSignalEnvelope(envelope) ? envelope : undefined;
}
