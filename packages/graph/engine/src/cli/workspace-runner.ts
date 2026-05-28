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

import { spawn } from 'node:child_process'
import { cpus } from 'node:os'
import { relative } from 'node:path'

import {
  ConfigurationError,
  logger,
  type LanguageAdapter,
  type WorkspaceUnit,
} from '@opensip-tools/core'

import type { CliOutput, FindingOutput } from '@opensip-tools/contracts'

/**
 * Per-unit result from a `graph --workspace` fan-out — one entry per
 * child process spawned by `runWorkspaceUnitsInParallel`.
 */
export interface WorkspaceUnitRunResult {
  /** Human-readable unit id (e.g. `core`, `cli`, `crate-foo`). */
  readonly unitId: string
  /** Absolute root dir the child was spawned against. */
  readonly rootDir: string
  /**
   * Project-relative path for display. Empty string if `rootDir` isn't
   * under `cwd`.
   */
  readonly displayPath: string
  readonly findings: readonly FindingOutput[]
  readonly exitCode: number
  readonly stderr: string
}

/**
 * Inputs to `runWorkspaceUnitsInParallel`. `units` is the flattened
 * polyglot list typically produced by `discoverPolyglotUnits`.
 */
export interface RunWorkspaceUnitsInput {
  readonly cwd: string
  readonly units: readonly WorkspaceUnit[]
  /**
   * Path to the CLI entry script — typically `process.argv[1]` from
   * the parent. Children invoke `node <cliScript> graph <rootDir>
   * --json`.
   */
  readonly cliScript: string
  /** Override concurrency for tests. Default: cpus()-1, min 1. */
  readonly concurrency?: number
  /** Forwarded to children if true. */
  readonly noCache?: boolean
}

/**
 * Aggregate output from `runWorkspaceUnitsInParallel` — per-unit
 * results plus a single boolean indicating whether any child failed.
 */
export interface RunWorkspaceUnitsOutput {
  readonly perUnit: readonly WorkspaceUnitRunResult[]
  readonly anyChildFailed: boolean
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
  const all: WorkspaceUnit[] = []
  for (const adapter of adapters) {
    if (!adapter.discoverWorkspaceUnits) continue
    const units = await adapter.discoverWorkspaceUnits(rootDir)
    all.push(...units)
  }
  all.sort((a, b) => a.rootDir.localeCompare(b.rootDir))
  return all
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
    )
  }

  const concurrency = Math.max(1, input.concurrency ?? Math.max(1, cpus().length - 1))
  logger.info({
    evt: 'graph.cli.workspace.start',
    module: 'graph:cli',
    units: input.units.length,
    concurrency,
  })

  // Simple worker-pool pattern: each slot runs one child at a time;
  // when a child finishes, the slot picks up the next pending unit.
  const queue = [...input.units]
  const results: WorkspaceUnitRunResult[] = []
  let anyChildFailed = false

  async function runOne(): Promise<void> {
    while (queue.length > 0) {
      const unit = queue.shift()
      if (unit === undefined) return
      const result = await spawnGraphChild({
        cliScript: input.cliScript,
        unit,
        cwd: input.cwd,
        noCache: input.noCache === true,
      })
      if (result.exitCode !== 0) anyChildFailed = true
      results.push(result)
    }
  }

  const workers: Promise<void>[] = []
  for (let i = 0; i < concurrency; i++) workers.push(runOne())
  await Promise.all(workers)

  // Sort for deterministic display order regardless of completion
  // order — units finish in unpredictable order under parallelism.
  results.sort((a, b) => a.rootDir.localeCompare(b.rootDir))

  logger.info({
    evt: 'graph.cli.workspace.complete',
    module: 'graph:cli',
    units: input.units.length,
    anyChildFailed,
  })

  return { perUnit: results, anyChildFailed }
}

interface SpawnInput {
  readonly cliScript: string
  readonly unit: WorkspaceUnit
  readonly cwd: string
  readonly noCache: boolean
}

function spawnGraphChild(input: SpawnInput): Promise<WorkspaceUnitRunResult> {
  return new Promise((resolvePromise) => {
    const args: string[] = [input.cliScript, 'graph', input.unit.rootDir, '--json']
    if (input.noCache) args.push('--no-cache')

    const child = spawn(process.execPath, args, {
      cwd: input.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (err) => {
      /* v8 ignore start */
      resolvePromise({
        unitId: input.unit.id,
        rootDir: input.unit.rootDir,
        displayPath: relative(input.cwd, input.unit.rootDir),
        findings: [],
        exitCode: -1,
        stderr: `failed to spawn child: ${err.message}`,
      })
      /* v8 ignore stop */
    })
    child.on('close', (code) => {
      const findings = parseChildFindings(stdout, input.unit.rootDir, stderr)
      resolvePromise({
        unitId: input.unit.id,
        rootDir: input.unit.rootDir,
        displayPath: relative(input.cwd, input.unit.rootDir),
        findings,
        /* v8 ignore next */
        exitCode: code ?? -1,
        stderr,
      })
    })
  })
}

/**
 * Parse a child's `--json` stdout into a flat FindingOutput[]. Returns
 * an empty array on parse failure; the caller surfaces the child's
 * stderr separately.
 */
function parseChildFindings(
  stdout: string,
  rootDir: string,
  stderr: string,
): readonly FindingOutput[] {
  const trimmed = stdout.trim()
  if (trimmed.length === 0) return []
  let parsed: CliOutput
  try {
    parsed = JSON.parse(trimmed) as CliOutput
  } catch (error) {
    /* v8 ignore start */
    logger.warn({
      evt: 'graph.cli.workspace.parse-error',
      module: 'graph:cli',
      rootDir,
      err: error instanceof Error ? error.message : String(error),
      stderrPreview: stderr.slice(0, 200),
    })
    return []
    /* v8 ignore stop */
  }
  const out: FindingOutput[] = []
  /* v8 ignore next 3 */
  for (const check of parsed.checks ?? []) {
    for (const finding of check.findings ?? []) out.push(finding)
  }
  return out
}
