// @fitness-ignore-file performance-anti-patterns -- discoverPolyglotUnits iterates the small fixed adapters list (5 languages); each adapter's discoverWorkspaceUnits performs I/O whose results depend on the per-adapter cwd state, so sequential await is intentional to keep error context attributable per adapter.
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

import {
  ConfigurationError,
  logger,
  type LanguageAdapter,
  type Signal,
  type WorkspaceUnit,
} from '@opensip-tools/core';

import { runWorkerPool } from './orchestrate/worker-pool.js';

import type { ResolutionMode } from '../types.js';
import type { SignalEnvelope } from '@opensip-tools/contracts';

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
}

/**
 * Inputs to `runWorkspaceUnitsInParallel`. `units` is the flattened
 * polyglot list typically produced by `discoverPolyglotUnits`.
 */
export interface RunWorkspaceUnitsInput {
  readonly cwd: string;
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
 * capped (default `cpus()-1`). Always resolves; child failures are
 * surfaced via `anyChildFailed`.
 */
export async function runWorkspaceUnitsInParallel(
  input: RunWorkspaceUnitsInput,
): Promise<RunWorkspaceUnitsOutput> {
  if (input.units.length === 0) {
    throw new ConfigurationError(
      '--workspace: no workspace units found. Use `opensip-tools graph` for whole-project analysis.',
    );
  }

  const concurrency = Math.max(1, input.concurrency ?? Math.max(1, cpus().length - 1));
  logger.info({
    evt: 'graph.cli.workspace.start',
    module: 'graph:cli',
    units: input.units.length,
    concurrency,
  });

  // Shared bounded worker pool (also used by the shard runner). Each slot
  // spawns one child at a time and pulls the next unit when it finishes.
  const results = await runWorkerPool(input.units, concurrency, (unit) =>
    spawnGraphChild({
      cliScript: input.cliScript,
      unit,
      cwd: input.cwd,
      noCache: input.noCache === true,
      resolution: input.resolution,
      recipe: input.recipe,
      ...(input.language === undefined ? {} : { language: input.language }),
    }),
  );
  const anyChildFailed = results.some((r) => r.exitCode !== 0);

  // Sort for deterministic display order regardless of completion
  // order — units finish in unpredictable order under parallelism.
  results.sort((a, b) => a.rootDir.localeCompare(b.rootDir));

  logger.info({
    evt: 'graph.cli.workspace.complete',
    module: 'graph:cli',
    units: input.units.length,
    anyChildFailed,
  });

  return { perUnit: results, anyChildFailed };
}

interface SpawnInput {
  readonly cliScript: string;
  readonly unit: WorkspaceUnit;
  readonly cwd: string;
  readonly noCache: boolean;
  readonly resolution?: ResolutionMode;
  readonly language?: string;
  readonly recipe?: string;
}

function spawnGraphChild(input: SpawnInput): Promise<WorkspaceUnitRunResult> {
  return new Promise((resolvePromise) => {
    const args: string[] = [input.cliScript, 'graph', input.unit.rootDir, '--json'];
    if (input.noCache) args.push('--no-cache');
    if (input.resolution !== undefined) args.push('--resolution', input.resolution);
    if (input.language !== undefined && input.language.length > 0)
      args.push('--language', input.language);
    if (input.recipe !== undefined) args.push('--recipe', input.recipe);

    const child = spawn(process.execPath, args, {
      cwd: input.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
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
    child.on('error', (err) => {
      /* v8 ignore start */
      resolvePromise({
        unitId: input.unit.id,
        rootDir: input.unit.rootDir,
        displayPath: relative(input.cwd, input.unit.rootDir),
        signals: [],
        exitCode: -1,
        stderr: `failed to spawn child: ${err.message}`,
      });
      /* v8 ignore stop */
    });
    child.on('close', (code) => {
      const signals = parseChildSignals(stdout, input.unit.rootDir, stderr);
      resolvePromise({
        unitId: input.unit.id,
        rootDir: input.unit.rootDir,
        displayPath: relative(input.cwd, input.unit.rootDir),
        signals,
        /* v8 ignore next */
        exitCode: code ?? -1,
        stderr,
      });
    });
  });
}

/**
 * Parse a child's `--json` {@link SignalEnvelope} stdout into a flat
 * `Signal[]` (ADR-0011 — `graph --json` now emits the envelope, not the
 * legacy `CliOutput`). Returns an empty array on parse failure; the caller
 * surfaces the child's stderr separately.
 */
function parseChildSignals(stdout: string, rootDir: string, stderr: string): readonly Signal[] {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return [];
  let parsed: SignalEnvelope;
  try {
    parsed = JSON.parse(trimmed) as SignalEnvelope;
  } catch (error) {
    /* v8 ignore start */
    logger.warn({
      evt: 'graph.cli.workspace.parse-error',
      module: 'graph:cli',
      rootDir,
      err: error instanceof Error ? error.message : String(error),
      stderrPreview: stderr.slice(0, 200),
    });
    return [];
    /* v8 ignore stop */
  }
  return parsed.signals ?? [];
}
