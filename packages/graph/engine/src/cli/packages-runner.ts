/**
 * `graph --packages` parallel runner — Wave 3 of
 * docs/plans/graph-performance-improvements.md.
 *
 * Fans a graph run out across every workspace package by spawning one
 * child process per package, each running `graph --package <dir>
 * --json`. Each child has its own Node heap, so the per-package
 * memory ceiling that Phase 6 already provides scales naturally:
 * N packages × ~per-package-budget ≈ total budget. Concurrency is
 * capped at `os.cpus().length - 1` (or a caller override) so we
 * don't oversubscribe.
 *
 * This is the "if Phase 6 + xargs is already fast enough" outcome
 * from §3 Wave 3 of the plan. It deliberately avoids `worker_threads`,
 * cross-partition resolution, and any catalog-merge logic; each
 * child's findings are aggregated as-is. Cross-package call edges
 * remain unresolved within each child (same fidelity as today's
 * `--package` runs); the trade-off is documented for users.
 */

import { spawn } from 'node:child_process';
import { cpus } from 'node:os';
import { relative } from 'node:path';

import { ConfigurationError, logger } from '@opensip-tools/core';

import type { CliOutput, FindingOutput } from '@opensip-tools/contracts';

export interface PackageRunResult {
  readonly packageDir: string;
  /**
   * Project-relative path for display. Empty string if `packageDir`
   * isn't under `cwd`.
   */
  readonly displayPath: string;
  readonly findings: readonly FindingOutput[];
  readonly exitCode: number;
  readonly stderr: string;
}

export interface RunPackagesInput {
  readonly cwd: string;
  readonly packageDirs: readonly string[];
  /**
   * Path to the CLI entry script — typically `process.argv[1]` from
   * the parent. Children invoke `node <cliScript> graph --package
   * <dir> --json`.
   */
  readonly cliScript: string;
  /** Override concurrency for tests. Default: cpus()-1, min 1. */
  readonly concurrency?: number;
  /** Forwarded to children if true. */
  readonly noCache?: boolean;
}

export interface RunPackagesOutput {
  readonly perPackage: readonly PackageRunResult[];
  readonly anyChildFailed: boolean;
}

export async function runPackagesInParallel(
  input: RunPackagesInput,
): Promise<RunPackagesOutput> {
  if (input.packageDirs.length === 0) {
    throw new ConfigurationError(
      '--packages: no workspace packages found. Pass an explicit --package <path> or check that packages/** has tsconfig.json files.',
    );
  }

  const concurrency = Math.max(1, input.concurrency ?? Math.max(1, cpus().length - 1));
  logger.info({
    evt: 'graph.cli.packages.start',
    module: 'graph:cli',
    packages: input.packageDirs.length,
    concurrency,
  });

  // Simple worker-pool pattern: each slot runs one child at a time;
  // when a child finishes, the slot picks up the next pending package.
  const queue = [...input.packageDirs];
  const results: PackageRunResult[] = [];
  let anyChildFailed = false;

  async function runOne(): Promise<void> {
    while (queue.length > 0) {
      const dir = queue.shift();
      if (dir === undefined) return;
      const result = await spawnGraphChild({
        cliScript: input.cliScript,
        packageDir: dir,
        cwd: input.cwd,
        noCache: input.noCache === true,
      });
      if (result.exitCode !== 0) anyChildFailed = true;
      results.push(result);
    }
  }

  const workers: Promise<void>[] = [];
  for (let i = 0; i < concurrency; i++) workers.push(runOne());
  await Promise.all(workers);

  // Sort for deterministic display order regardless of completion
  // order — packages finish in unpredictable order under parallelism.
  results.sort((a, b) => a.packageDir.localeCompare(b.packageDir));

  logger.info({
    evt: 'graph.cli.packages.complete',
    module: 'graph:cli',
    packages: input.packageDirs.length,
    anyChildFailed,
  });

  return { perPackage: results, anyChildFailed };
}

interface SpawnInput {
  readonly cliScript: string;
  readonly packageDir: string;
  readonly cwd: string;
  readonly noCache: boolean;
}

function spawnGraphChild(input: SpawnInput): Promise<PackageRunResult> {
  return new Promise((resolvePromise) => {
    const args: string[] = [
      input.cliScript,
      'graph',
      '--package',
      input.packageDir,
      '--json',
    ];
    if (input.noCache) args.push('--no-cache');

    const child = spawn(process.execPath, args, {
      cwd: input.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      /* v8 ignore start -- spawn-error path; only fires when Node
         can't spawn the child at all (e.g. ENOENT for execPath). */
      resolvePromise({
        packageDir: input.packageDir,
        displayPath: relative(input.cwd, input.packageDir),
        findings: [],
        exitCode: -1,
        stderr: `failed to spawn child: ${err.message}`,
      });
      /* v8 ignore stop */
    });
    child.on('close', (code) => {
      const findings = parseChildFindings(stdout, input.packageDir, stderr);
      resolvePromise({
        packageDir: input.packageDir,
        displayPath: relative(input.cwd, input.packageDir),
        findings,
        exitCode: code ?? -1,
        stderr,
      });
    });
  });
}

/**
 * Parse a child's `--json` stdout into a flat FindingOutput[]. Returns
 * an empty array on parse failure; the caller surfaces the child's
 * stderr separately.
 */
function parseChildFindings(
  stdout: string,
  packageDir: string,
  stderr: string,
): readonly FindingOutput[] {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return [];
  let parsed: CliOutput;
  try {
    parsed = JSON.parse(trimmed) as CliOutput;
  } catch (error) {
    logger.warn({
      evt: 'graph.cli.packages.parseError',
      module: 'graph:cli',
      packageDir,
      err: error instanceof Error ? error.message : String(error),
      stderrPreview: stderr.slice(0, 200),
    });
    return [];
  }
  const out: FindingOutput[] = [];
  for (const check of parsed.checks ?? []) {
    for (const finding of check.findings ?? []) out.push(finding);
  }
  return out;
}
